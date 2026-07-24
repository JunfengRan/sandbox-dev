import { z } from 'zod'
import { Buffer } from 'node:buffer'
import { DaytonaNotFoundError } from '@daytona/sdk'
import type { PluginInput } from '@opencode-ai/plugin'
import type { ToolContext } from '@opencode-ai/plugin/tool'
import type { BrokerSessionManager } from './broker-session-manager.js'
import { wrapCommand, resolveSandboxPath } from './isolation.js'

export function createTools(sessionManager: BrokerSessionManager, projectId: string, worktree: string, pluginCtx: PluginInput) {
  return {
    bash: {
      description: 'Executes shell commands in a Daytona sandbox via broker',
      args: {
        command: z.string(),
        background: z.boolean().optional(),
      },
      async execute(args: { command: string; background?: boolean }, ctx: ToolContext) {
        const sessionId = ctx.sessionID
        const sandbox = await sessionManager.getSandbox(sessionId, projectId, worktree, pluginCtx)
        const isolation = sessionManager.getIsolation(sessionId)
        const workDir = sessionManager.getWorkDir(sessionId)
        const command = wrapCommand(args.command, isolation)

        if (args.background) {
          const execSessionId = isolation?.processSessionId ?? `exec-session-${sessionId}`
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

        const result = await sandbox.process.executeCommand(command, workDir)
        return `Exit code: ${result.exitCode}\n${result.result}`
      },
    },
    read: {
      description: 'Reads a file from the Daytona sandbox',
      args: { filePath: z.string() },
      async execute(args: { filePath: string }, ctx: ToolContext) {
        const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
        const path = resolveSandboxPath(args.filePath, sessionManager.getIsolation(ctx.sessionID))
        const buffer = await sandbox.fs.downloadFile(path)
        return new TextDecoder().decode(buffer)
      },
    },
    write: {
      description: 'Writes a file in the Daytona sandbox',
      args: { filePath: z.string(), content: z.string() },
      async execute(args: { filePath: string; content: string }, ctx: ToolContext) {
        const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
        const path = resolveSandboxPath(args.filePath, sessionManager.getIsolation(ctx.sessionID))
        await sandbox.fs.uploadFile(Buffer.from(args.content, 'utf-8'), path)
        return `Wrote ${path}`
      },
    },
    edit: {
      description: 'Edits a file in the Daytona sandbox by replacing text',
      args: {
        filePath: z.string(),
        oldString: z.string(),
        newString: z.string(),
      },
      async execute(args: { filePath: string; oldString: string; newString: string }, ctx: ToolContext) {
        const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
        const path = resolveSandboxPath(args.filePath, sessionManager.getIsolation(ctx.sessionID))
        const buffer = await sandbox.fs.downloadFile(path)
        const content = new TextDecoder().decode(buffer)
        if (!content.includes(args.oldString)) {
          throw new Error(`oldString not found in ${path}`)
        }
        const updated = content.replace(args.oldString, args.newString)
        await sandbox.fs.uploadFile(Buffer.from(updated, 'utf-8'), path)
        return `Edited ${path}`
      },
    },
    glob: {
      description: 'Find files by glob pattern in the sandbox',
      args: { pattern: z.string() },
      async execute(args: { pattern: string }, ctx: ToolContext) {
        const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
        const workDir = sessionManager.getWorkDir(ctx.sessionID)
        const result = await sandbox.process.executeCommand(`find ${workDir} -path '${workDir}/${args.pattern}' 2>/dev/null | head -100`)
        return result.result.trim() || '(no matches)'
      },
    },
    grep: {
      description: 'Search file contents in the sandbox',
      args: { pattern: z.string(), path: z.string().optional() },
      async execute(args: { pattern: string; path?: string }, ctx: ToolContext) {
        const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
        const workDir = sessionManager.getWorkDir(ctx.sessionID)
        const target = args.path ? resolveSandboxPath(args.path, sessionManager.getIsolation(ctx.sessionID)) : workDir
        const result = await sandbox.process.executeCommand(`grep -R -n -- '${args.pattern.replace(/'/g, `'\\''`)}' ${target} 2>/dev/null | head -100`)
        return result.result.trim() || '(no matches)'
      },
    },
    ls: {
      description: 'List directory contents in the sandbox',
      args: { path: z.string().optional() },
      async execute(args: { path?: string }, ctx: ToolContext) {
        const sandbox = await sessionManager.getSandbox(ctx.sessionID, projectId, worktree, pluginCtx)
        const target = args.path
          ? resolveSandboxPath(args.path, sessionManager.getIsolation(ctx.sessionID))
          : sessionManager.getWorkDir(ctx.sessionID)
        const result = await sandbox.process.executeCommand(`ls -la ${target}`)
        return result.result
      },
    },
  }
}
