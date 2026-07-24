import type { ExecResult, IsolationInfo } from '@sandbox-dev/shared'
import type { SandboxHandle } from './sandbox-handle.js'

export class E2BSandboxHandle implements SandboxHandle {
  constructor(
    public readonly id: string,
    private readonly runtimeUrl: string,
  ) {}

  static connect(sandboxId: string, runtimeUrl?: string): E2BSandboxHandle {
    const url =
      runtimeUrl ??
      process.env.E2B_RUNTIME_URL ??
      process.env.DAYTONA_E2B_RUNTIME_URL ??
      'http://localhost:8090'
    return new E2BSandboxHandle(sandboxId, url.replace(/\/$/, ''))
  }

  async start(): Promise<void> {
    await this.request(`/v1/sandboxes/${encodeURIComponent(this.id)}/start`, {
      method: 'POST',
      body: '{}',
    })
  }

  async exec(command: string, cwd?: string): Promise<ExecResult> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(this.id)}/exec`, {
      method: 'POST',
      body: JSON.stringify({ command, cwd }),
    })
    return (await res.json()) as ExecResult
  }

  async readFile(path: string, _isolation?: IsolationInfo): Promise<string> {
    const res = await this.request(`/v1/sandboxes/${encodeURIComponent(this.id)}/files/read`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    })
    const data = (await res.json()) as { content: string }
    return data.content
  }

  async writeFile(path: string, content: string, _isolation?: IsolationInfo): Promise<void> {
    await this.request(`/v1/sandboxes/${encodeURIComponent(this.id)}/files/write`, {
      method: 'POST',
      body: JSON.stringify({ path, content }),
    })
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined),
    }
    const res = await fetch(`${this.runtimeUrl}${path}`, { ...init, headers })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`E2B runtime ${path} failed (${res.status}): ${text}`)
    }
    return res
  }
}
