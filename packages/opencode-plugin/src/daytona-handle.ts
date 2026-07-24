import { Daytona, type Sandbox } from '@daytona/sdk'
import type { ExecResult, IsolationInfo } from '@sandbox-dev/shared'
import type { SandboxHandle } from './sandbox-handle.js'

export class DaytonaSandboxHandle implements SandboxHandle {
  constructor(
    public readonly id: string,
    private readonly sandbox: Sandbox,
  ) {}

  static async connect(apiKey: string, sandboxId: string): Promise<DaytonaSandboxHandle> {
    const daytona = new Daytona({
      apiKey,
      apiUrl: process.env.DAYTONA_API_URL,
      target: process.env.DAYTONA_TARGET,
    })
    const sandbox = await daytona.get(sandboxId)
    if (sandbox.state !== 'started') {
      await sandbox.start()
    }
    return new DaytonaSandboxHandle(sandboxId, sandbox)
  }

  async start(): Promise<void> {
    await this.sandbox.refreshData()
    if (this.sandbox.state !== 'started') {
      await this.sandbox.start()
    }
  }

  async exec(command: string, cwd?: string): Promise<ExecResult> {
    const result = await this.sandbox.process.executeCommand(command, cwd)
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.result ?? '',
      stderr: '',
    }
  }

  async readFile(path: string, _isolation?: IsolationInfo): Promise<string> {
    const buffer = await this.sandbox.fs.downloadFile(path)
    return new TextDecoder().decode(buffer)
  }

  async writeFile(path: string, content: string, _isolation?: IsolationInfo): Promise<void> {
    await this.sandbox.fs.uploadFile(Buffer.from(content, 'utf-8'), path)
  }

  /** Expose raw SDK sandbox for process-session background commands. */
  get raw(): Sandbox {
    return this.sandbox
  }
}
