import type {
  BrokerMode,
  IdlePolicy,
  ProcessLimits,
  SandboxProviderName,
  SandboxResources,
  SandboxSizeProfile,
} from '@sandbox-dev/shared'
import { PROJECT_BASE_PATH, SIZE_PROFILES } from '@sandbox-dev/shared'
import { parseSandboxProvider } from './providers/index.js'

export interface Config {
  port: number
  redisUrl: string
  kafkaBrokers: string[]
  sandboxProvider: SandboxProviderName
  daytonaApiUrl: string
  daytonaApiKey: string
  daytonaTarget: string
  e2bRuntimeUrl: string
  e2bImage: string
  e2bCpu: number
  e2bMemoryMiB: number
  e2bWorkDir: string
  maxConcurrency: number
  idlePolicy: IdlePolicy
  defaultMode: BrokerMode
  jwtSecret?: string
  defaultPoolId: string
  snapshot?: string
  projectBasePath: string
  leaseTtlMs: number
  leaseSweepIntervalMs: number
  sizeProfile: SandboxSizeProfile
  defaultResources: SandboxResources
  defaultProcessLimits?: ProcessLimits
}

function resolveResources(): { profile: SandboxSizeProfile; resources: SandboxResources } {
  const profile = (process.env.SANDBOX_SIZE_PROFILE ?? 'small') as SandboxSizeProfile
  if (profile === 'small' || profile === 'medium' || profile === 'large') {
    const base = SIZE_PROFILES[profile]
    return {
      profile,
      resources: {
        cpu: Number(process.env.SANDBOX_CPU ?? base.cpu),
        memoryMiB: Number(process.env.SANDBOX_MEMORY_MIB ?? base.memoryMiB),
        diskGiB: Number(process.env.SANDBOX_DISK_GIB ?? base.diskGiB ?? 3),
      },
    }
  }
  return {
    profile: 'custom',
    resources: {
      cpu: Number(process.env.SANDBOX_CPU ?? process.env.E2B_DEFAULT_CPU ?? 0.5),
      memoryMiB: Number(process.env.SANDBOX_MEMORY_MIB ?? process.env.E2B_DEFAULT_MEMORY_MIB ?? 512),
      diskGiB: Number(process.env.SANDBOX_DISK_GIB ?? 3),
    },
  }
}

function resolveProcessLimits(): ProcessLimits | undefined {
  const cpuSeconds = process.env.PROCESS_LIMIT_CPU_SECONDS
    ? Number(process.env.PROCESS_LIMIT_CPU_SECONDS)
    : undefined
  const memoryMiB = process.env.PROCESS_LIMIT_MEMORY_MIB
    ? Number(process.env.PROCESS_LIMIT_MEMORY_MIB)
    : undefined
  const maxProcesses = process.env.PROCESS_LIMIT_MAX_PROCESSES
    ? Number(process.env.PROCESS_LIMIT_MAX_PROCESSES)
    : undefined
  const maxOpenFiles = process.env.PROCESS_LIMIT_MAX_OPEN_FILES
    ? Number(process.env.PROCESS_LIMIT_MAX_OPEN_FILES)
    : undefined
  if (cpuSeconds || memoryMiB || maxProcesses || maxOpenFiles) {
    return { cpuSeconds, memoryMiB, maxProcesses, maxOpenFiles }
  }
  return undefined
}

export function loadConfig(): Config {
  const sandboxProvider = parseSandboxProvider(process.env.SANDBOX_PROVIDER)
  const { profile, resources } = resolveResources()
  return {
    port: Number(process.env.PORT ?? 8080),
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    kafkaBrokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').map((s) => s.trim()),
    sandboxProvider,
    daytonaApiUrl: process.env.DAYTONA_API_URL ?? 'http://localhost:3000/api',
    daytonaApiKey: process.env.DAYTONA_API_KEY ?? '',
    daytonaTarget: process.env.DAYTONA_TARGET ?? 'us',
    e2bRuntimeUrl: process.env.E2B_RUNTIME_URL ?? 'http://localhost:8090',
    e2bImage: process.env.E2B_IMAGE ?? 'sandbox-dev/e2b-runtime:0.1.0',
    e2bCpu: resources.cpu,
    e2bMemoryMiB: resources.memoryMiB,
    e2bWorkDir: process.env.E2B_WORK_DIR ?? PROJECT_BASE_PATH.e2b,
    maxConcurrency: Number(process.env.MAX_SANDBOX_CONCURRENCY ?? 2),
    idlePolicy: (process.env.IDLE_POLICY ?? 'stop_keep') as IdlePolicy,
    defaultMode: (process.env.DEFAULT_BROKER_MODE ?? 'exclusive') as BrokerMode,
    jwtSecret: process.env.JWT_SECRET,
    defaultPoolId: process.env.DEFAULT_POOL_ID ?? 'default',
    snapshot: process.env.DAYTONA_SNAPSHOT,
    projectBasePath: process.env.PROJECT_BASE_PATH ?? PROJECT_BASE_PATH[sandboxProvider],
    leaseTtlMs: Number(process.env.LEASE_TTL_MS ?? 120_000),
    leaseSweepIntervalMs: Number(process.env.LEASE_SWEEP_INTERVAL_MS ?? 30_000),
    sizeProfile: profile,
    defaultResources: resources,
    defaultProcessLimits: resolveProcessLimits(),
  }
}
