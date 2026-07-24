import type { BrokerMode, IdlePolicy, IsolationInfo } from '@sandbox-dev/shared'
import {
  REDIS_KEYS,
  hashUserToLinuxUser,
  processSessionId,
  sessionWorkDir,
} from '@sandbox-dev/shared'
import type { Redis } from 'ioredis'

export interface LeaseRecord {
  userId: string
  sessionId: string
  sandboxId: string
  mode: BrokerMode
  acquiredAt: number
  lastHeartbeat: number
  workDir: string
  processSessionId: string
  isolation: IsolationInfo
  poolId?: string
}

export interface TicketRecord {
  ticketId: string
  userId: string
  sessionId: string
  mode: BrokerMode
  poolId?: string
  status: 'queued' | 'ready' | 'expired' | 'claiming'
  queuePosition: number
  sandboxId?: string
  workDir?: string
  processSessionId?: string
  isolation?: IsolationInfo
  createdAt: number
}

export function buildIsolation(
  mode: BrokerMode,
  userId: string,
  sessionId: string,
  basePath?: string,
): IsolationInfo {
  const procId = processSessionId(sessionId)
  const workDir = sessionWorkDir(mode, userId, sessionId, basePath)

  switch (mode) {
    case 'user_shared':
      return { type: 'session_dir', workDir, processSessionId: procId }
    case 'multi_user_shared':
      return {
        type: 'linux_user',
        workDir,
        processSessionId: procId,
        linuxUser: hashUserToLinuxUser(userId),
        wrapCommand: true,
      }
    default:
      return { type: 'none', workDir, processSessionId: procId }
  }
}

const ACQUIRE_SLOT_SCRIPT = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', key) or '0')
if current < max then
  redis.call('INCR', key)
  return 1
end
return 0
`

const RELEASE_SLOT_SCRIPT = `
local key = KEYS[1]
local current = tonumber(redis.call('GET', key) or '0')
if current > 0 then
  redis.call('DECR', key)
end
return redis.call('GET', key)
`

/** Atomically claim a queued ticket for processing (queued -> claiming). */
const CLAIM_TICKET_SCRIPT = `
local key = KEYS[1]
local raw = redis.call('GET', key)
if not raw then
  return nil
end
local ticket = cjson.decode(raw)
if ticket['status'] ~= 'queued' then
  return nil
end
ticket['status'] = 'claiming'
redis.call('SET', key, cjson.encode(ticket))
return redis.call('GET', key)
`

export class LeaseManager {
  constructor(
    private readonly redis: Redis,
    private readonly maxConcurrency: number,
    private readonly idlePolicy: IdlePolicy,
  ) {}

  async getActiveCount(): Promise<number> {
    return Number((await this.redis.get(REDIS_KEYS.activeCount)) ?? 0)
  }

  async tryAcquireSlot(): Promise<boolean> {
    const result = await this.redis.eval(ACQUIRE_SLOT_SCRIPT, 1, REDIS_KEYS.activeCount, this.maxConcurrency)
    return result === 1
  }

  async releaseSlot(): Promise<number> {
    const result = await this.redis.eval(RELEASE_SLOT_SCRIPT, 1, REDIS_KEYS.activeCount)
    return Number(result ?? 0)
  }

  async getLease(userId: string, sessionId: string): Promise<LeaseRecord | null> {
    const raw = await this.redis.get(REDIS_KEYS.lease(userId, sessionId))
    return raw ? (JSON.parse(raw) as LeaseRecord) : null
  }

  async saveLease(lease: LeaseRecord): Promise<void> {
    await this.redis.set(REDIS_KEYS.lease(lease.userId, lease.sessionId), JSON.stringify(lease))
  }

  async deleteLease(userId: string, sessionId: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.lease(userId, sessionId))
  }

  async getUserSandbox(userId: string): Promise<string | null> {
    return this.redis.get(REDIS_KEYS.userSandbox(userId))
  }

  async setUserSandbox(userId: string, sandboxId: string): Promise<void> {
    await this.redis.set(REDIS_KEYS.userSandbox(userId), sandboxId)
  }

  async clearUserSandbox(userId: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.userSandbox(userId))
  }

  async getPoolSandbox(poolId: string): Promise<string | null> {
    return this.redis.get(REDIS_KEYS.poolSandbox(poolId))
  }

  async setPoolSandbox(poolId: string, sandboxId: string): Promise<void> {
    await this.redis.set(REDIS_KEYS.poolSandbox(poolId), sandboxId)
  }

  async clearPoolSandbox(poolId: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.poolSandbox(poolId))
  }

  async getSessionSandbox(userId: string, sessionId: string): Promise<string | null> {
    return this.redis.get(REDIS_KEYS.sessionSandbox(userId, sessionId))
  }

  async setSessionSandbox(userId: string, sessionId: string, sandboxId: string): Promise<void> {
    await this.redis.set(REDIS_KEYS.sessionSandbox(userId, sessionId), sandboxId)
  }

  async clearSessionSandbox(userId: string, sessionId: string): Promise<void> {
    await this.redis.del(REDIS_KEYS.sessionSandbox(userId, sessionId))
  }

  async enqueueTicket(ticket: TicketRecord): Promise<number> {
    await this.redis.set(REDIS_KEYS.ticket(ticket.ticketId), JSON.stringify(ticket))
    const position = await this.redis.rpush(REDIS_KEYS.queue, ticket.ticketId)
    return position
  }

  async getTicket(ticketId: string): Promise<TicketRecord | null> {
    const raw = await this.redis.get(REDIS_KEYS.ticket(ticketId))
    return raw ? (JSON.parse(raw) as TicketRecord) : null
  }

  async updateTicket(ticket: TicketRecord): Promise<void> {
    await this.redis.set(REDIS_KEYS.ticket(ticket.ticketId), JSON.stringify(ticket))
  }

  /** Claim ticket for exclusive processing. Returns null if already claimed/ready. */
  async claimTicket(ticketId: string): Promise<TicketRecord | null> {
    const raw = await this.redis.eval(CLAIM_TICKET_SCRIPT, 1, REDIS_KEYS.ticket(ticketId))
    if (!raw || typeof raw !== 'string') return null
    return JSON.parse(raw) as TicketRecord
  }

  async dequeueTicket(): Promise<string | null> {
    return this.redis.lpop(REDIS_KEYS.queue)
  }

  async queueLength(): Promise<number> {
    return this.redis.llen(REDIS_KEYS.queue)
  }

  async listLeases(): Promise<LeaseRecord[]> {
    const keys = await this.redis.keys('sandbox:lease:*')
    if (keys.length === 0) return []
    const values = await this.redis.mget(...keys)
    return values.filter(Boolean).map((v) => JSON.parse(v!) as LeaseRecord)
  }

  getIdlePolicy(): IdlePolicy {
    return this.idlePolicy
  }
}
