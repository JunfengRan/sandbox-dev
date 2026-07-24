import { Daytona, type Sandbox } from '@daytona/sdk'
import { asLinuxUser } from '@sandbox-dev/shared'
import type { Config } from '../config.js'

export class DaytonaService {
  private readonly daytona: Daytona

  constructor(private readonly config: Config) {
    this.daytona = new Daytona({
      apiKey: config.daytonaApiKey,
      apiUrl: config.daytonaApiUrl,
      target: config.daytonaTarget,
    })
  }

  async createSandbox(labels?: Record<string, string>): Promise<Sandbox> {
    const params: Record<string, unknown> = { labels }
    if (this.config.snapshot) {
      params.snapshot = this.config.snapshot
    }
    const sandbox = await this.daytona.create(params as Parameters<Daytona['create']>[0])
    await sandbox.start()
    return sandbox
  }

  async getSandbox(sandboxId: string): Promise<Sandbox> {
    const sandbox = await this.daytona.get(sandboxId)
    if (sandbox.state !== 'started') {
      await sandbox.start()
    }
    return sandbox
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId)
    if (sandbox.state === 'started') {
      await sandbox.stop()
    }
  }

  async deleteSandbox(sandboxId: string): Promise<void> {
    const sandbox = await this.daytona.get(sandboxId)
    await sandbox.delete()
  }

  async ensureWorkDir(sandboxId: string, workDir: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId)
    await sandbox.process.executeCommand(`mkdir -p ${workDir}`)
  }

  async setupMultiUserDirs(sandboxId: string, _userId: string, _sessionId: string, workDir: string): Promise<void> {
    const sandbox = await this.getSandbox(sandboxId)
    const linuxUser = workDir.split('/')[2]
    await sandbox.process.executeCommand(asLinuxUser(linuxUser, `mkdir -p ${workDir}`))
  }
}
