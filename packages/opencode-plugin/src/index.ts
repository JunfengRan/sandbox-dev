import { join } from 'path'
import { homedir } from 'os'
import { xdgData } from 'xdg-basedir'
import type { PluginInput } from '@opencode-ai/plugin'
import { BrokerSessionManager } from './broker-session-manager.js'
import { eventHandlers, systemPromptTransform } from './session-events.js'
import { createTools } from './tools.js'
import { logger, setLogFilePath } from './logger.js'

const xdgDataDir = xdgData ?? join(homedir(), '.local', 'share')
const LOG_FILE = join(xdgDataDir, 'opencode', 'log', 'daytona-broker.log')
const REPO_PATH =
  process.env.SANDBOX_PROVIDER === 'e2b' || process.env.E2B_RUNTIME_URL
    ? (process.env.E2B_WORK_DIR ?? '/home/user/project')
    : '/home/daytona/project'

setLogFilePath(LOG_FILE)

export default async function daytonaBrokerPlugin(ctx: PluginInput) {
  const brokerUrl = process.env.DAYTONA_BROKER_URL
  if (!brokerUrl) {
    throw new Error('DAYTONA_BROKER_URL is required for @sandbox-dev/opencode-plugin')
  }

  const apiKey = process.env.DAYTONA_API_KEY ?? ''
  const token = process.env.DAYTONA_BROKER_TOKEN
  const sessionManager = new BrokerSessionManager(apiKey, brokerUrl, REPO_PATH, token)

  logger.info(
    `OpenCode started with Sandbox Broker plugin url=${brokerUrl} mode=${sessionManager.getMode()} repoPath=${REPO_PATH}`,
  )

  const projectId = ctx.project.id
  const worktree = ctx.project.worktree

  return {
    tool: createTools(sessionManager, projectId, worktree, ctx),
    event: await eventHandlers(ctx, sessionManager),
    'experimental.chat.system.transform': await systemPromptTransform(ctx, REPO_PATH),
  }
}
