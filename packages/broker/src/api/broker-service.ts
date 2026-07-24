import type { AcquireRequest, AcquireResponse, BrokerMode, ReleaseRequest } from '@sandbox-dev/shared'
import { v4 as uuidv4 } from 'uuid'
import type { Config } from '../config.js'
import type { DaytonaService } from '../daytona/client.js'
import { buildIsolation, type LeaseManager, type LeaseRecord, type TicketRecord } from '../state/lease-manager.js'
import type { QueueService } from '../queue/kafka.js'

export class BrokerService {
  constructor(
    private readonly config: Config,
    private readonly leases: LeaseManager,
    private readonly daytona: DaytonaService,
    private readonly queue: QueueService,
  ) {}

  async acquire(req: AcquireRequest): Promise<AcquireResponse> {
    const mode = req.mode ?? this.config.defaultMode
    const poolId = req.poolId ?? this.config.defaultPoolId

    const existing = await this.leases.getLease(req.userId, req.sessionId)
    if (existing) {
      return this.toAcquireResponse(existing)
    }

    const attachOnly = await this.canAttachSharedSandbox(mode, req.userId, poolId)
    if (!attachOnly) {
      const hasSlot = await this.leases.tryAcquireSlot()
      if (!hasSlot) {
        return this.enqueue(req, mode, poolId)
      }
    }

    try {
      const lease = await this.createLease(req.userId, req.sessionId, mode, poolId)
      return this.toAcquireResponse(lease)
    } catch (err) {
      if (!attachOnly) {
        await this.leases.releaseSlot()
      }
      throw err
    }
  }

  private async canAttachSharedSandbox(mode: BrokerMode, userId: string, poolId: string): Promise<boolean> {
    if (mode === 'user_shared') {
      return !!(await this.leases.getUserSandbox(userId))
    }
    if (mode === 'multi_user_shared') {
      return !!(await this.leases.getPoolSandbox(poolId))
    }
    return false
  }

  private async countLeasesForSandbox(sandboxId: string): Promise<number> {
    const leases = await this.leases.listLeases()
    return leases.filter((l) => l.sandboxId === sandboxId).length
  }

  private async enqueue(req: AcquireRequest, mode: BrokerMode, poolId: string): Promise<AcquireResponse> {
    const ticketId = uuidv4()
    const position = await this.leases.queueLength()
    const ticket: TicketRecord = {
      ticketId,
      userId: req.userId,
      sessionId: req.sessionId,
      mode,
      poolId,
      status: 'queued',
      queuePosition: position + 1,
      createdAt: Date.now(),
    }
    const queuePosition = await this.leases.enqueueTicket(ticket)
    await this.queue.publish({
      ticketId,
      userId: req.userId,
      sessionId: req.sessionId,
      mode,
      poolId,
      timestamp: Date.now(),
    })
    return { status: 'queued', ticketId, queuePosition }
  }

  async poll(ticketId: string) {
    const ticket = await this.leases.getTicket(ticketId)
    if (!ticket) return { status: 'released' as const }
    if (ticket.status === 'ready' && ticket.sandboxId) {
      return {
        status: 'ready' as const,
        sandboxId: ticket.sandboxId,
        workDir: ticket.workDir,
        processSessionId: ticket.processSessionId,
        isolation: ticket.isolation,
      }
    }
    return { status: 'queued' as const, queuePosition: ticket.queuePosition }
  }

  async release(req: ReleaseRequest): Promise<void> {
    const lease = await this.leases.getLease(req.userId, req.sessionId)
    if (!lease) return

    const reason = req.reason ?? 'idle'
    const sandboxId = lease.sandboxId
    await this.leases.deleteLease(req.userId, req.sessionId)

    const remaining = await this.countLeasesForSandbox(sandboxId)
    if (remaining > 0) {
      await this.processQueue()
      return
    }

    if (reason === 'deleted') {
      await this.daytona.deleteSandbox(sandboxId)
      await this.cleanupMappings(lease)
      await this.leases.releaseSlot()
    } else {
      const policy = this.leases.getIdlePolicy()
      if (policy === 'delete') {
        await this.daytona.deleteSandbox(sandboxId)
        await this.cleanupMappings(lease)
        await this.leases.clearSessionSandbox(req.userId, req.sessionId)
      } else if (policy === 'stop_keep') {
        await this.daytona.stopSandbox(sandboxId)
        await this.leases.setSessionSandbox(req.userId, req.sessionId, sandboxId)
      }
      await this.leases.releaseSlot()
    }

    await this.processQueue()
  }

  async heartbeat(userId: string, sessionId: string): Promise<boolean> {
    const lease = await this.leases.getLease(userId, sessionId)
    if (!lease) return false
    lease.lastHeartbeat = Date.now()
    await this.leases.saveLease(lease)
    return true
  }

  async status() {
    const leases = await this.leases.listLeases()
    return {
      activeCount: await this.leases.getActiveCount(),
      maxConcurrency: this.config.maxConcurrency,
      queueLength: await this.leases.queueLength(),
      leases: leases.map((l) => ({
        userId: l.userId,
        sessionId: l.sessionId,
        sandboxId: l.sandboxId,
        acquiredAt: l.acquiredAt,
      })),
    }
  }

  async processQueueMessage(msg: { ticketId: string; userId: string; sessionId: string; mode: BrokerMode; poolId?: string }) {
    const ticket = await this.leases.getTicket(msg.ticketId)
    if (!ticket || ticket.status !== 'queued') return

    const hasSlot = await this.leases.tryAcquireSlot()
    if (!hasSlot) {
      await this.leases.enqueueTicket(ticket)
      return
    }

    try {
      const lease = await this.createLease(msg.userId, msg.sessionId, msg.mode, msg.poolId ?? this.config.defaultPoolId)
      ticket.status = 'ready'
      ticket.sandboxId = lease.sandboxId
      ticket.workDir = lease.workDir
      ticket.processSessionId = lease.processSessionId
      ticket.isolation = lease.isolation
      await this.leases.updateTicket(ticket)
    } catch (err) {
      await this.leases.releaseSlot()
      throw err
    }
  }

  private async processQueue(): Promise<void> {
    const ticketId = await this.leases.dequeueTicket()
    if (!ticketId) return

    const ticket = await this.leases.getTicket(ticketId)
    if (!ticket || ticket.status !== 'queued') {
      await this.processQueue()
      return
    }

    const hasSlot = await this.leases.tryAcquireSlot()
    if (!hasSlot) {
      await this.leases.enqueueTicket(ticket)
      return
    }

    try {
      const lease = await this.createLease(ticket.userId, ticket.sessionId, ticket.mode, ticket.poolId ?? this.config.defaultPoolId)
      ticket.status = 'ready'
      ticket.sandboxId = lease.sandboxId
      ticket.workDir = lease.workDir
      ticket.processSessionId = lease.processSessionId
      ticket.isolation = lease.isolation
      await this.leases.updateTicket(ticket)
    } catch {
      await this.leases.releaseSlot()
      await this.leases.enqueueTicket(ticket)
    }
  }

  private async createLease(userId: string, sessionId: string, mode: BrokerMode, poolId: string): Promise<LeaseRecord> {
    const isolation = buildIsolation(mode, userId, sessionId)
    let sandboxId: string | null = null

    if (mode === 'user_shared') {
      sandboxId = await this.leases.getUserSandbox(userId)
    } else if (mode === 'multi_user_shared') {
      sandboxId = await this.leases.getPoolSandbox(poolId)
    } else {
      sandboxId = await this.leases.getSessionSandbox(userId, sessionId)
    }

    if (sandboxId) {
      await this.daytona.getSandbox(sandboxId)
    } else {
      const labels: Record<string, string> = { mode, userId }
      if (poolId) labels.poolId = poolId
      const sandbox = await this.daytona.createSandbox(labels)
      sandboxId = sandbox.id
      if (mode === 'user_shared') await this.leases.setUserSandbox(userId, sandboxId)
      if (mode === 'multi_user_shared') await this.leases.setPoolSandbox(poolId, sandboxId)
      if (mode === 'exclusive') await this.leases.setSessionSandbox(userId, sessionId, sandboxId)
    }

    await this.daytona.ensureWorkDir(sandboxId, isolation.workDir)
    if (mode === 'multi_user_shared') {
      await this.daytona.setupMultiUserDirs(sandboxId, userId, sessionId, isolation.workDir)
    }

    const lease: LeaseRecord = {
      userId,
      sessionId,
      sandboxId,
      mode,
      poolId,
      acquiredAt: Date.now(),
      lastHeartbeat: Date.now(),
      workDir: isolation.workDir,
      processSessionId: isolation.processSessionId,
      isolation,
    }
    await this.leases.saveLease(lease)
    return lease
  }

  private async cleanupMappings(lease: LeaseRecord): Promise<void> {
    await this.leases.clearSessionSandbox(lease.userId, lease.sessionId)
    if (lease.mode === 'user_shared') {
      const current = await this.leases.getUserSandbox(lease.userId)
      if (current === lease.sandboxId) await this.leases.clearUserSandbox(lease.userId)
    }
    if (lease.mode === 'multi_user_shared' && lease.poolId) {
      const current = await this.leases.getPoolSandbox(lease.poolId)
      if (current === lease.sandboxId) await this.leases.clearPoolSandbox(lease.poolId)
    }
  }

  private toAcquireResponse(lease: LeaseRecord): AcquireResponse {
    return {
      status: 'granted',
      leaseId: `${lease.userId}:${lease.sessionId}`,
      sandboxId: lease.sandboxId,
      workDir: lease.workDir,
      processSessionId: lease.processSessionId,
      isolation: lease.isolation,
    }
  }
}
