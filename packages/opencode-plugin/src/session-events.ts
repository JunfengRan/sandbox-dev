import type { PluginInput } from '@opencode-ai/plugin'
import { logger } from './logger.js'
import type { BrokerSessionManager } from './broker-session-manager.js'

const EVENT_SESSION_DELETED = 'session.deleted'
const EVENT_SESSION_IDLE = 'session.idle'

export async function eventHandlers(ctx: PluginInput, sessionManager: BrokerSessionManager) {
  return async (args: { event: { type: string; properties: Record<string, unknown> } }) => {
    const event = args.event
    if (event.type === EVENT_SESSION_DELETED) {
      const info = event.properties.info as { id: string }
      try {
        await sessionManager.releaseSandbox(info.id, 'deleted')
      } catch (err) {
        logger.error(`Failed to release sandbox on delete: ${err}`)
        throw err
      }
    } else if (event.type === EVENT_SESSION_IDLE) {
      const sessionId = event.properties.sessionID as string
      try {
        await sessionManager.releaseSandbox(sessionId, 'idle')
        logger.info(`Released sandbox slot on idle sessionId=${sessionId}`)
      } catch (err) {
        logger.error(`Failed to release sandbox on idle: ${err}`)
      }
    }
  }
}

export async function systemPromptTransform(_ctx: PluginInput, repoPath: string) {
  return async (
    _input: { sessionID?: string },
    output: { system: string[] },
  ) => {
    output.system.push(
      [
        '## Daytona Sandbox Broker Integration',
        'Tool calls run in a remote Linux Daytona sandbox managed by Sandbox Broker.',
        `Default project path: ${repoPath}.`,
        'In shared modes each session uses an isolated work directory inside the sandbox.',
        "For long-running commands use the bash tool's background option.",
      ].join('\n'),
    )
  }
}
