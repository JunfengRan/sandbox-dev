export type BrokerMode = 'exclusive' | 'user_shared' | 'multi_user_shared'

export type IdlePolicy = 'stop_keep' | 'delete' | 'pool'

export type LeaseStatus = 'active' | 'queued' | 'released' | 'ready'

export interface AcquireRequest {
  userId: string
  sessionId: string
  mode?: BrokerMode
  poolId?: string
}

export interface AcquireResponse {
  status: 'granted' | 'queued'
  leaseId?: string
  sandboxId?: string
  ticketId?: string
  queuePosition?: number
  workDir?: string
  processSessionId?: string
  isolation?: IsolationInfo
}

export interface IsolationInfo {
  type: 'none' | 'session_dir' | 'linux_user' | 'bubblewrap'
  workDir: string
  processSessionId: string
  linuxUser?: string
  wrapCommand?: boolean
}

export interface ReleaseRequest {
  userId: string
  sessionId: string
  reason?: 'idle' | 'deleted'
}

export interface HeartbeatRequest {
  userId: string
  sessionId: string
}

export interface PollResponse {
  status: LeaseStatus
  sandboxId?: string
  queuePosition?: number
  workDir?: string
  processSessionId?: string
  isolation?: IsolationInfo
}

export interface BrokerStatus {
  activeCount: number
  maxConcurrency: number
  queueLength: number
  leases: Array<{
    userId: string
    sessionId: string
    sandboxId: string
    acquiredAt: number
  }>
}

export interface QueueMessage {
  ticketId: string
  userId: string
  sessionId: string
  mode: BrokerMode
  poolId?: string
  timestamp: number
}

export const KAFKA_TOPIC_ACQUIRE = 'sandbox-acquire-requests'

export const REDIS_KEYS = {
  activeCount: 'sandbox:active_count',
  lease: (userId: string, sessionId: string) => `sandbox:lease:${userId}:${sessionId}`,
  userSandbox: (userId: string) => `sandbox:user:${userId}`,
  poolSandbox: (poolId: string) => `sandbox:pool:${poolId}`,
  sessionSandbox: (userId: string, sessionId: string) => `sandbox:session:${userId}:${sessionId}`,
  ticket: (ticketId: string) => `sandbox:queue:ticket:${ticketId}`,
  queue: 'sandbox:queue:waiting',
} as const

export function hashUserToLinuxUser(userId: string, max = 32): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  }
  const index = (hash % max) + 1
  return `ocuser_${String(index).padStart(3, '0')}`
}

export function sessionWorkDir(
  mode: BrokerMode,
  userId: string,
  sessionId: string,
  basePath = '/home/daytona/project',
): string {
  switch (mode) {
    case 'user_shared':
      return `${basePath}/sessions/${sessionId}`
    case 'multi_user_shared': {
      const linuxUser = hashUserToLinuxUser(userId)
      return `/home/${linuxUser}/project/sessions/${sessionId}`
    }
    default:
      return basePath
  }
}

export function processSessionId(sessionId: string): string {
  return `exec-session-${sessionId}`
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Run a shell script as a pre-provisioned ocuser_* Linux account (via sudo). */
export function asLinuxUser(linuxUser: string, command: string): string {
  return `sudo -u ${linuxUser} -- bash -lc ${shellQuote(command)}`
}
