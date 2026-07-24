import { z } from 'zod'
import { DaytonaNotFoundError } from '@daytona/sdk'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { BrokerSessionManager } from './broker-session-manager.js'
import { DaytonaSandboxHandle } from './daytona-handle.js'
import { wrapCommand, resolveSandboxPath } from './isolation.js'
import { isolatedRead, isolatedWrite } from './sandbox-handle.js'

export function createTools(
  sessionManager: BrokerSessionManager,
  projectId: string,
  worktree: string,
  pluginCtx: PluginInput,
) {
  return {
    bash: {
      description: 'Executes shell commands in a remote sandbox via broker',
      args: {
        command: z.string(),
        background: z.boolean().optional(),
      },
      async execute(args: { command: string; background?: boolean }, ctx: ToolContext) {
        const sessionId = ctx.sessionID
        const handle = await sessionManager.getHandle(sessionId, projectId, worktree, pluginCtx)
        const isolation = sessionManager.getIsolation(sessionId)
        const workDir = sessionManager.getWorkDir(sessionId)
        const command = wrapCommand(args.command, isolation)

        if (args.background && handle instanceof DaytonaSandboxHandle) {
          const execSessionId = isolation?.processSessionId ?? `exec-session-${sessionId}`
          const sandbox = handle.raw
          try {
            await sandbox.process.getSession(execSessionId)
          } catch (err) {
            if (!(err instanceof DaytonaNotFoundError)) throw err
            await sandbox.process.createSession(execSessionId)
          }
          await sandbox.process.executeSessionCommand(execSessionId, {
            command: `cd ${workDir}`,
          })
          const result = await sandbox.process.executeSessionCommand(execSessionId, {
            command,
            runAsync: true,
          })
          return `Command started in background (cmdId: ${result.cmdId})`
        }

        if (args.background) {
          // E2B-compatible: fire-and-forget via nohup
          const result = await handle.exec(`nohup bash -lc ${JSON.stringify(command)} >/tmp/bg.out 2>&1 & echo $!`, workDir)
          return `Command started in background (pid: ${result.stdout.trim()})`
        }

        const result = await handle.exec(command, workDir)
        return `Exit code: ${result.exitCode}\n${result.stdout}${result.stderr}`
      },
    },
    read: {
      description: 'Reads a file from the remote sandbox',
      args: { filePath: z.string() },
      async execute(args: { filePath: string }, ctx: ToolContext) {
        const handle = await sessionManager.getHandle(ctx.sessionID, projectId, worktree, pluginCtx)
        const isolation = sessionManager.getIsolation(ctx.sessionID)
        const path = resolveSandboxPath(args.filePath, isolation)
        return isolatedRead(handle, path, isolation)
      },
    },
    write: {
      description: 'Writes a file in the remote sandbox',
      args: { filePath: z.string(), content: z.string() },
      async execute(args: { filePath: string; content: string }, ctx: ToolContext) {
        const handle = await sessionManager.getHandle(ctx.sessionID, projectId, worktree, pluginCtx)
        const isolation = sessionManager.getIsolation(ctx.sessionID)
        const path = resolveSandboxPath(args.filePath, isolation)
        await isolatedWrite(handle, path, args.content, isolation)
        return `Wrote ${path}`
      },
    },
    edit: {
      description: 'Edits a file in the remote sandbox by replacing text',
      args: {
        filePath: z.string(),
        oldString: z.string(),
        newString: z.string(),
      },
      async execute(args: { filePath: string; oldString: string; newString: string }, ctx: ToolContext) {
        const handle = await sessionManager.getHandle(ctx.sessionID, projectId, worktree, pluginCtx)
        const isolation = sessionManager.getIsolation(ctx.sessionID)
        const path = resolveSandboxPath(args.filePath, isolation)
        const content = await isolatedRead(handle, path, isolation)
        if (!content.includes(args.oldString)) {
          throw new Error(`oldString not found in ${path}`)
        }
        const updated = content.replace(args.oldString, args.newString)
        await isolatedWrite(handle, path, updated, isolation)
        return `Edited ${path}`
      },
    },
    glob: {
      description: 'Find files by glob pattern in the sandbox',
      args: { pattern: z.string() },
      async execute(args: { pattern: string }, ctx: ToolContext) {
        const handle = await sessionManager.getHandle(ctx.sessionID, projectId, worktree, pluginCtx)
        const workDir = sessionManager.getWorkDir(ctx.sessionID)
        const isolation = sessionManager.getIsolation(ctx.sessionID)
        const command = wrapCommand(
          `find ${workDir} -path '${workDir}/${args.pattern}' 2>/dev/null | head -100`,
          isolation,
        )
        const result = await handle.exec(command)
        return result.stdout.trim() || '(no matches)'
      },
    },
    grep: {
      description: 'Search file contents in the sandbox',
      args: { pattern: z.string(), path: z.string().optional() },
      async execute(args: { pattern: string; path?: string }, ctx: ToolContext) {
        const handle = await sessionManager.getHandle(ctx.sessionID, projectId, worktree, pluginCtx)
        const isolation = sessionManager.getIsolation(ctx.sessionID)
        const workDir = sessionManager.getWorkDir(ctx.sessionID)
        const target = args.path ? resolveSandboxPath(args.path, isolation) : workDir
        const command = wrapCommand(
          `grep -R -n -- '${args.pattern.replace(/'/g, `'\\''`)}' ${target} 2>/dev/null | head -100`,
          isolation,
        )
        const result = await handle.exec(command)
        return result.stdout.trim() || '(no matches)'
      },
    },
    ls: {
      description: 'List directory contents in the sandbox',
      args: { path: z.string().optional() },
      async execute(args: { path?: string }, ctx: ToolContext) {
        const handle = await sessionManager.getHandle(ctx.sessionID, projectId, worktree, pluginCtx)
        const isolation = sessionManager.getIsolation(ctx.sessionID)
        const target = args.path
          ? resolveSandboxPath(args.path, isolation)
          : sessionManager.getWorkDir(ctx.sessionID)
        const command = wrapCommand(`ls -la ${target}`, isolation)
        const result = await handle.exec(command)
        return result.stdout
      },
    },
  }
}
