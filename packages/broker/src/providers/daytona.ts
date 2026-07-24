import { Daytona, type Sandbox } from '@daytona/sdk'
import {
  asLinuxUser,
  wrapWithProcessLimits,
  type ExecOptions,
  type ExecResult,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxResources,
} from '@sandbox-dev/shared'
import type { Config } from '../config.js'

function mapState(state: string | undefined): SandboxInfo['state'] {
  if (state === 'started' || state === 'running') return 'started'
  if (state === 'stopped' || state === 'stopping') return 'stopped'
  return state ?? 'stopped'
}

function toDaytonaResources(resources: SandboxResources) {
  return {
    cpu: Math.max(1, Math.ceil(resources.cpu)),
    memory: Math.max(1, Math.ceil(resources.memoryMiB / 1024)),
    disk: Math.max(1, Math.ceil(resources.diskGiB ?? 3)),
  }
}

function fromDaytonaSandbox(sandbox: Sandbox): SandboxResources | undefined {
  const cpu = (sandbox as { cpu?: number }).cpu
  const memory = (sandbox as { memory?: number }).memory
  const disk = (sandbox as { disk?: number }).disk
  if (cpu == null && memory == null) return undefined
  return {
    cpu: cpu ?? 1,
    memoryMiB: (memory ?? 1) * 1024,
    diskGiB: disk,
  }
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = 'daytona' as const
  private readonly daytona: Daytona

  constructor(private readonly config: Config) {
    this.daytona = new Daytona({
      apiKey: config.daytonaApiKey,
      apiUrl: config.daytonaApiUrl,
      target: config.daytonaTarget,
    })
  }

  async create(labels?: Record<string, string>, resources?: SandboxResources): Promise<SandboxInfo> {
    const resolved = resources ?? this.config.defaultResources
    const params: Record<string, unknown> = {
      labels,
      resources: toDaytonaResources(resolved),
    }
    if (this.config.snapshot) {
      params.snapshot = this.config.snapshot
    }
    const sandbox = await this.daytona.create(params as Parameters<Daytona['create']>[0])
    await sandbox.start()
    return {
      id: sandbox.id,
      state: 'started',
      resources: fromDaytonaSandbox(sandbox) ?? resolved,
    }
  }

  async get(id: string): Promise<SandboxInfo> {
    const sandbox = await this.getRaw(id)
    return {
      id: sandbox.id,
      state: mapState(sandbox.state),
      resources: fromDaytonaSandbox(sandbox),
    }
  }

  async start(id: string): Promise<void> {
    const sandbox = await this.daytona.get(id)
    if (sandbox.state !== 'started') {
      await sandbox.start()
    }
  }

  async stop(id: string): Promise<void> {
    const sandbox = await this.daytona.get(id)
    if (sandbox.state === 'started') {
      await sandbox.stop()
    }
  }

  async delete(id: string): Promise<void> {
    const sandbox = await this.daytona.get(id)
    await sandbox.delete()
  }

  async resize(id: string, resources: SandboxResources): Promise<SandboxInfo> {
    const sandbox = await this.getRaw(id)
    const target = toDaytonaResources(resources)
    const currentCpu = (sandbox as { cpu?: number }).cpu ?? 1
    const currentMem = (sandbox as { memory?: number }).memory ?? 1
    const needDecrease = target.cpu < currentCpu || target.memory < currentMem

    if (needDecrease && sandbox.state === 'started') {
      await sandbox.stop()
    }
    await sandbox.resize(target)
    if (sandbox.state !== 'started') {
      await sandbox.start()
    }
    const refreshed = await this.daytona.get(id)
    return {
      id: refreshed.id,
      state: mapState(refreshed.state),
      resources: fromDaytonaSandbox(refreshed) ?? resources,
    }
  }

  async exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult> {
    const sandbox = await this.getRaw(id)
    const limits = opts?.processLimits ?? this.config.defaultProcessLimits
    const wrapped = wrapWithProcessLimits(command, limits)
    const result = await sandbox.process.executeCommand(wrapped, opts?.cwd)
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.result ?? '',
      stderr: '',
    }
  }

  async ensureWorkDir(id: string, workDir: string): Promise<void> {
    await this.exec(id, `mkdir -p ${workDir}`)
  }

  async setupMultiUserDirs(id: string, workDir: string): Promise<void> {
    const linuxUser = workDir.split('/')[2]
    await this.exec(id, asLinuxUser(linuxUser, `mkdir -p ${workDir}`))
  }

  async getRaw(id: string): Promise<Sandbox> {
    const sandbox = await this.daytona.get(id)
    if (sandbox.state !== 'started') {
      await sandbox.start()
    }
    return sandbox
  }
}
