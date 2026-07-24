import type { AcquireResponse, BrokerMode, IsolationInfo, PollResponse } from '@sandbox-dev/shared'

export class BrokerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly userId: string,
    private readonly token?: string,
    private readonly mode: BrokerMode = 'exclusive',
  ) {}

  async acquire(sessionId: string, poolId?: string): Promise<AcquireResponse> {
    const res = await this.request('/v1/leases/acquire', {
      method: 'POST',
      body: JSON.stringify({ userId: this.userId, sessionId, mode: this.mode, poolId }),
    })
    const data = (await res.json()) as AcquireResponse
    if (data.status === 'queued' && data.ticketId) {
      return this.pollUntilReady(data.ticketId)
    }
    return data
  }

  async pollUntilReady(ticketId: string, maxAttempts = 120, intervalMs = 2000): Promise<AcquireResponse> {
    for (let i = 0; i < maxAttempts; i++) {
      const res = await this.request(`/v1/leases/poll?ticketId=${encodeURIComponent(ticketId)}`)
      const data = (await res.json()) as PollResponse
      if (data.status === 'ready' && data.sandboxId) {
        return {
          status: 'granted',
          sandboxId: data.sandboxId,
          provider: data.provider,
          workDir: data.workDir,
          processSessionId: data.processSessionId,
          isolation: data.isolation,
        }
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    throw new Error(`Timed out waiting for sandbox queue ticket ${ticketId}`)
  }

  async release(sessionId: string, reason: 'idle' | 'deleted' = 'idle'): Promise<void> {
    await this.request('/v1/leases/release', {
      method: 'POST',
      body: JSON.stringify({ userId: this.userId, sessionId, reason }),
    })
  }

  async heartbeat(sessionId: string): Promise<void> {
    await this.request('/v1/leases/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ userId: this.userId, sessionId }),
    })
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string>),
    }
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Broker ${path} failed (${res.status}): ${text}`)
    }
    return res
  }
}

export function resolveUserId(): string {
  return process.env.OPENCODE_USER_ID ?? process.env.USERNAME ?? process.env.USER ?? 'anonymous'
}

export function resolveBrokerMode(): BrokerMode {
  const mode = process.env.DAYTONA_BROKER_MODE ?? 'exclusive'
  if (mode === 'user_shared' || mode === 'multi_user_shared') return mode
  return 'exclusive'
}

export function isGitSyncEnabled(mode: BrokerMode): boolean {
  return mode === 'exclusive'
}

export type { IsolationInfo }
