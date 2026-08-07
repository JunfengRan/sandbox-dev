import {
  asLinuxUser,
  wrapWithProcessLimits,
  type ExecOptions,
  type ExecResult,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxResources,
  type SandboxService,
  type SandboxServiceEndpoint,
  type SandboxServiceSpec,
} from '@sandbox-dev/shared'
import type { Config } from '../config.js'

interface RuntimeSandboxResponse {
  id?: string
  sandboxId?: string
  state: string
  workDir?: string
  resources?: SandboxResources
}

export class AioSandboxProvider implements SandboxProvider {
  readonly name = 'aio' as const

  constructor(private readonly config: Config) {}

  private get baseUrl(): string {
    return this.config.aioRuntimeUrl.replace(/\/$/, '')
  }

  async create(labels?: Record<string, string>, resources?: SandboxResources): Promise<SandboxInfo> {
    const resolved = resources ?? this.config.defaultResources
    const res = await this.request('/v1/sandboxes', {
      method: 'POST',
      body: JSON.stringify({
        image: this.config.aioImage,
        labels,
        cpu: resolved.cpu,
        memoryMiB: resolved.memoryMiB,
        workDir: this.config.aioWorkDir,
      }),
    })
    const data = (await res.json()) as RuntimeSandboxResponse
    const id = data.sandboxId ?? data.id
    if (!id) throw new Error('AIO runtime create did not return id')
    return {
      id,
      state: (data.state as SandboxInfo['state']) ?? 'started',
      resources: data.resources ?? resolved,
    }
  }

  async get(id: string): Promise<SandboxInfo> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(id)}`)
    const data = (await res.json()) as RuntimeSandboxResponse
    return {
      id: data.sandboxId ?? data.id ?? id,
      state: (data.state as SandboxInfo['state']) ?? 'stopped',
      resources: data.resources,
    }
  }

  async start(id: string): Promise<void> {
    await this.request(`/v1/sandboxes/${encodeURIComponent(id)}/start`, { method: 'POST', body: '{}' })
  }

  async stop(id: string): Promise<void> {
    await this.request(`/v1/sandboxes/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' })
  }

  async delete(id: string): Promise<void> {
    await this.request(`/v1/sandboxes/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async resize(id: string, resources: SandboxResources): Promise<SandboxInfo> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(id)}/resize`, {
      method: 'POST',
      body: JSON.stringify({
        cpu: resources.cpu,
        memoryMiB: resources.memoryMiB,
      }),
    })
    const data = (await res.json()) as RuntimeSandboxResponse
    return {
      id: data.sandboxId ?? data.id ?? id,
      state: (data.state as SandboxInfo['state']) ?? 'started',
      resources: data.resources ?? resources,
    }
  }

  async exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult> {
    const limits = opts?.processLimits ?? this.config.defaultProcessLimits
    const wrapped = wrapWithProcessLimits(command, limits)
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(id)}/exec`, {
      method: 'POST',
      body: JSON.stringify({ command: wrapped, cwd: opts?.cwd }),
    })
    return (await res.json()) as ExecResult
  }

  async ensureWorkDir(id: string, workDir: string): Promise<void> {
    await this.exec(id, `mkdir -p ${workDir}`)
  }

  async startService(id: string, spec: SandboxServiceSpec): Promise<SandboxService> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(id)}/services`, {
      method: 'POST',
      body: JSON.stringify(spec),
    })
    return (await res.json()) as SandboxService
  }

  async getServiceEndpoint(id: string, name: string): Promise<SandboxServiceEndpoint> {
    const res = await this.request(
      `/v1/sandboxes/${encodeURIComponent(id)}/services/${encodeURIComponent(name)}/endpoint`,
    )
    return (await res.json()) as SandboxServiceEndpoint
  }

  async stopService(id: string, name: string): Promise<SandboxService> {
    const res = await this.request(
      `/v1/sandboxes/${encodeURIComponent(id)}/services/${encodeURIComponent(name)}`,
      { method: 'DELETE' },
    )
    return (await res.json()) as SandboxService
  }

  async setupMultiUserDirs(id: string, workDir: string): Promise<void> {
    const linuxUser = workDir.split('/')[2]
    await this.exec(id, asLinuxUser(linuxUser, `mkdir -p ${workDir}`))
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    }
    const res = await fetch(`${this.baseUrl}${path}`, { ...init, headers })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`AIO runtime ${path} failed (${res.status}): ${text}`)
    }
    return res
  }
}
