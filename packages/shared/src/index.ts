export type BrokerMode = 'exclusive' | 'user_shared' | 'multi_user_shared'

export type IdlePolicy = 'stop_keep' | 'delete' | 'pool'

export type LeaseStatus = 'active' | 'queued' | 'released' | 'ready'

/** Control-plane compute backend (Hands layer). */
export type SandboxProviderName = 'daytona' | 'e2b'

export interface AcquireRequest {
  userId: string
  sessionId: string
  mode?: BrokerMode
  poolId?: string
  /** Optional per-lease size override (else broker default profile). */
  resources?: SandboxResources
  sizeProfile?: SandboxSizeProfile
}

export interface AcquireResponse {
  status: 'granted' | 'queued'
  leaseId?: string
  sandboxId?: string
  provider?: SandboxProviderName
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
  provider?: SandboxProviderName
  queuePosition?: number
  workDir?: string
  processSessionId?: string
  isolation?: IsolationInfo
}

export interface BrokerStatus {
  activeCount: number
  maxConcurrency: number
  queueLength: number
  provider: SandboxProviderName
  sizeProfile?: SandboxSizeProfile
  defaultResources?: SandboxResources
  processLimits?: ProcessLimits | null
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

export interface SandboxInfo {
  id: string
  state: 'creating' | 'started' | 'stopped' | 'archived' | string
  resources?: SandboxResources
}

/** Per-sandbox compute envelope (elastic size on a host/server). */
export interface SandboxResources {
  /** vCPU cores (fractional OK for e2b; Daytona rounds up to int ≥1). */
  cpu: number
  /** Memory in MiB. */
  memoryMiB: number
  /** Disk in GiB (Daytona / optional for e2b). */
  diskGiB?: number
}

/** Per-process hard caps applied around each exec (ulimit/prlimit). */
export interface ProcessLimits {
  /** CPU time seconds (prlimit --cpu / ulimit -t). */
  cpuSeconds?: number
  /** Address-space / virtual memory MiB. */
  memoryMiB?: number
  /** Max processes for the session shell. */
  maxProcesses?: number
  /** Max open files. */
  maxOpenFiles?: number
}

export type SandboxSizeProfile = 'small' | 'medium' | 'large' | 'custom'

export const SIZE_PROFILES: Record<Exclude<SandboxSizeProfile, 'custom'>, SandboxResources> = {
  small: { cpu: 0.5, memoryMiB: 512, diskGiB: 3 },
  medium: { cpu: 1, memoryMiB: 1024, diskGiB: 5 },
  large: { cpu: 2, memoryMiB: 2048, diskGiB: 10 },
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  processLimits?: ProcessLimits
}

/**
 * Provider-agnostic sandbox lifecycle used by the Broker (Hands / compute plane).
 * Aligns with Claude Managed Agents self-hosted worker + OpenAI SandboxClient shapes
 * at the control-plane level only (no agent harness).
 */
export interface SandboxProvider {
  readonly name: SandboxProviderName
  create(labels?: Record<string, string>, resources?: SandboxResources): Promise<SandboxInfo>
  get(id: string): Promise<SandboxInfo>
  start(id: string): Promise<void>
  stop(id: string): Promise<void>
  delete(id: string): Promise<void>
  /** Hot/cold resize of sandbox envelope (elastic scaling). */
  resize(id: string, resources: SandboxResources): Promise<SandboxInfo>
  exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult>
  ensureWorkDir(id: string, workDir: string): Promise<void>
  setupMultiUserDirs?(id: string, workDir: string): Promise<void>
}

/** Wrap a shell command with process-level resource caps. */
export function wrapWithProcessLimits(command: string, limits?: ProcessLimits): string {
  if (!limits) return command

  const hasAny =
    (limits.cpuSeconds && limits.cpuSeconds > 0) ||
    (limits.memoryMiB && limits.memoryMiB > 0) ||
    (limits.maxProcesses && limits.maxProcesses > 0) ||
    (limits.maxOpenFiles && limits.maxOpenFiles > 0)
  if (!hasAny) return command

  const prlimit: string[] = []
  if (limits.cpuSeconds && limits.cpuSeconds > 0) prlimit.push(`--cpu=${Math.floor(limits.cpuSeconds)}`)
  if (limits.memoryMiB && limits.memoryMiB > 0) {
    prlimit.push(`--as=${Math.floor(limits.memoryMiB) * 1024 * 1024}`)
  }
  if (limits.maxProcesses && limits.maxProcesses > 0) prlimit.push(`--nproc=${Math.floor(limits.maxProcesses)}`)
  if (limits.maxOpenFiles && limits.maxOpenFiles > 0) prlimit.push(`--nofile=${Math.floor(limits.maxOpenFiles)}`)

  const ulimits: string[] = []
  if (limits.cpuSeconds && limits.cpuSeconds > 0) ulimits.push(`ulimit -t ${Math.floor(limits.cpuSeconds)}`)
  if (limits.memoryMiB && limits.memoryMiB > 0) ulimits.push(`ulimit -v ${Math.floor(limits.memoryMiB) * 1024}`)
  if (limits.maxProcesses && limits.maxProcesses > 0) ulimits.push(`ulimit -u ${Math.floor(limits.maxProcesses)}`)
  if (limits.maxOpenFiles && limits.maxOpenFiles > 0) ulimits.push(`ulimit -n ${Math.floor(limits.maxOpenFiles)}`)

  const quoted = shellQuote(command)
  const prlimitCmd = `prlimit ${prlimit.join(' ')} -- bash -lc ${quoted}`
  const ulimitCmd = `${ulimits.join('; ')}; bash -lc ${quoted}`
  return `if command -v prlimit >/dev/null 2>&1; then ${prlimitCmd}; else ${ulimitCmd}; fi`
}

export const KAFKA_TOPIC_ACQUIRE = 'sandbox-acquire-requests'

export const PROJECT_BASE_PATH: Record<SandboxProviderName, string> = {
  daytona: '/home/daytona/project',
  e2b: '/home/user/project',
}

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
  basePath = PROJECT_BASE_PATH.daytona,
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
