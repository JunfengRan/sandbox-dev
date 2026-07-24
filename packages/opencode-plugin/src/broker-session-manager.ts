import { Daytona, DaytonaNotFoundError, type Sandbox } from '@daytona/sdk'
import type { IsolationInfo } from '@sandbox-dev/shared'
import { asLinuxUser } from '@sandbox-dev/shared'
import type { PluginInput } from '@opencode-ai/plugin'
import { BrokerClient, isGitSyncEnabled, resolveBrokerMode, resolveUserId } from './broker-client.js'
import { logger } from './logger.js'

interface SessionState {
  sandbox: Sandbox
  sandboxId: string
  isolation?: IsolationInfo
  workDir: string
}

export class BrokerSessionManager {
  private readonly daytona: Daytona
  private readonly broker: BrokerClient
  private readonly sessions = new Map<string, SessionState>()
  private readonly mode = resolveBrokerMode()
  public readonly repoPath: string

  constructor(
    private readonly apiKey: string,
    private readonly brokerUrl: string,
    repoPath: string,
    private readonly token?: string,
  ) {
    this.daytona = new Daytona({
      apiKey: apiKey,
      apiUrl: process.env.DAYTONA_API_URL,
      target: process.env.DAYTONA_TARGET,
    })
    this.broker = new BrokerClient(brokerUrl, resolveUserId(), token, this.mode)
    this.repoPath = repoPath
  }

  getMode() {
    return this.mode
  }

  isGitSyncEnabled() {
    return isGitSyncEnabled(this.mode)
  }

  getIsolation(sessionId: string): IsolationInfo | undefined {
    return this.sessions.get(sessionId)?.isolation
  }

  getWorkDir(sessionId: string): string {
    return this.sessions.get(sessionId)?.workDir ?? this.repoPath
  }

  async getSandbox(sessionId: string, _projectId: string, _worktree: string, _pluginCtx?: PluginInput): Promise<Sandbox> {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      await existing.sandbox.refreshData()
      if (existing.sandbox.state !== 'started') {
        await existing.sandbox.start()
      }
      await this.broker.heartbeat(sessionId)
      return existing.sandbox
    }

    if (!this.apiKey) {
      throw new Error('DAYTONA_API_KEY is not set')
    }

    logger.info(`Acquiring sandbox via broker sessionId=${sessionId} mode=${this.mode}`)
    const acquired = await this.broker.acquire(sessionId, process.env.DAYTONA_POOL_ID)
    if (!acquired.sandboxId) {
      throw new Error('Broker did not return sandboxId')
    }

    logger.info(`Reconnecting sandboxId=${acquired.sandboxId}`)
    const sandbox = await this.daytona.get(acquired.sandboxId)
    if (sandbox.state !== 'started') {
      await sandbox.start()
    }

    const workDir = acquired.workDir ?? acquired.isolation?.workDir ?? this.repoPath
    const isolation = acquired.isolation

    if (isolation && isolation.type !== 'none') {
      await sandbox.process.executeCommand(`mkdir -p ${workDir}`)
      await this.ensureProcessSession(sandbox, isolation.processSessionId, workDir, isolation)
    }

    this.sessions.set(sessionId, { sandbox, sandboxId: acquired.sandboxId, isolation, workDir })
    return sandbox
  }

  async releaseSandbox(sessionId: string, reason: 'idle' | 'deleted' = 'idle'): Promise<void> {
    logger.info(`Releasing sandbox sessionId=${sessionId} reason=${reason}`)
    await this.broker.release(sessionId, reason)
    // Clear cache so the next tool call re-acquires a broker slot after idle.
    this.sessions.delete(sessionId)
  }

  private async ensureProcessSession(
    sandbox: Sandbox,
    processSessionId: string,
    workDir: string,
    isolation: IsolationInfo,
  ): Promise<void> {
    try {
      await sandbox.process.getSession(processSessionId)
    } catch (err) {
      if (!(err instanceof DaytonaNotFoundError)) throw err
      await sandbox.process.createSession(processSessionId)
    }

    const cdCommand =
      isolation.type === 'linux_user' && isolation.linuxUser
        ? asLinuxUser(isolation.linuxUser, `mkdir -p ${workDir} && cd ${workDir}`)
        : `mkdir -p ${workDir} && cd ${workDir}`

    await sandbox.process.executeSessionCommand(processSessionId, { command: cdCommand })
  }
}
