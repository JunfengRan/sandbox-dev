import { DaytonaNotFoundError } from '@daytona/sdk'
import type { IsolationInfo, SandboxProviderName } from '@sandbox-dev/shared'
import { asLinuxUser } from '@sandbox-dev/shared'
import type { PluginInput } from '@opencode-ai/plugin'
import { BrokerClient, isGitSyncEnabled, resolveBrokerMode, resolveUserId } from './broker-client.js'
import { DaytonaSandboxHandle } from './daytona-handle.js'
import { E2BSandboxHandle } from './e2b-handle.js'
import { logger } from './logger.js'
import type { SandboxHandle } from './sandbox-handle.js'

interface SessionState {
  handle: SandboxHandle
  sandboxId: string
  provider: SandboxProviderName
  isolation?: IsolationInfo
  workDir: string
}

export class BrokerSessionManager {
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

  async getHandle(
    sessionId: string,
    _projectId: string,
    _worktree: string,
    _pluginCtx?: PluginInput,
  ): Promise<SandboxHandle> {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      await existing.handle.start()
      await this.broker.heartbeat(sessionId)
      return existing.handle
    }

    logger.info(`Acquiring sandbox via broker sessionId=${sessionId} mode=${this.mode}`)
    const acquired = await this.broker.acquire(sessionId, process.env.DAYTONA_POOL_ID)
    if (!acquired.sandboxId) {
      throw new Error('Broker did not return sandboxId')
    }

    const provider: SandboxProviderName = acquired.provider ?? resolvePreferredProvider()
    logger.info(`Reconnecting sandboxId=${acquired.sandboxId} provider=${provider}`)

    const handle =
      provider === 'e2b'
        ? E2BSandboxHandle.connect(acquired.sandboxId)
        : await this.connectDaytona(acquired.sandboxId)

    await handle.start()

    const workDir = acquired.workDir ?? acquired.isolation?.workDir ?? this.repoPath
    const isolation = acquired.isolation

    if (isolation && isolation.type !== 'none') {
      await handle.exec(`mkdir -p ${workDir}`)
      await this.ensureProcessSession(handle, isolation.processSessionId, workDir, isolation)
    }

    this.sessions.set(sessionId, {
      handle,
      sandboxId: acquired.sandboxId,
      provider,
      isolation,
      workDir,
    })
    return handle
  }

  /** @deprecated Use getHandle — kept for call-site migration */
  async getSandbox(sessionId: string, projectId: string, worktree: string, pluginCtx?: PluginInput) {
    return this.getHandle(sessionId, projectId, worktree, pluginCtx)
  }

  async releaseSandbox(sessionId: string, reason: 'idle' | 'deleted' = 'idle'): Promise<void> {
    logger.info(`Releasing sandbox sessionId=${sessionId} reason=${reason}`)
    await this.broker.release(sessionId, reason)
    this.sessions.delete(sessionId)
  }

  private async connectDaytona(sandboxId: string): Promise<DaytonaSandboxHandle> {
    if (!this.apiKey) {
      throw new Error('DAYTONA_API_KEY is not set (required for daytona provider)')
    }
    return DaytonaSandboxHandle.connect(this.apiKey, sandboxId)
  }

  private async ensureProcessSession(
    handle: SandboxHandle,
    processSessionId: string,
    workDir: string,
    isolation: IsolationInfo,
  ): Promise<void> {
    if (handle instanceof DaytonaSandboxHandle) {
      const sandbox = handle.raw
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
      return
    }

    // E2B-compatible: no persistent process sessions — cwd applied per exec
    const cdCommand =
      isolation.type === 'linux_user' && isolation.linuxUser
        ? asLinuxUser(isolation.linuxUser, `mkdir -p ${workDir}`)
        : `mkdir -p ${workDir}`
    await handle.exec(cdCommand)
  }
}

function resolvePreferredProvider(): SandboxProviderName {
  return process.env.SANDBOX_PROVIDER === 'e2b' ? 'e2b' : 'daytona'
}
