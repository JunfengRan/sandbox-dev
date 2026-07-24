import type { ExecResult, IsolationInfo } from '@sandbox-dev/shared'
import { asLinuxUser, shellQuote } from '@sandbox-dev/shared'

/** Provider-agnostic handle used by OpenCode tools (Hands plane). */
export interface SandboxHandle {
  readonly id: string
  start(): Promise<void>
  exec(command: string, cwd?: string): Promise<ExecResult>
  readFile(path: string, isolation?: IsolationInfo): Promise<string>
  writeFile(path: string, content: string, isolation?: IsolationInfo): Promise<void>
}

export async function isolatedRead(
  handle: SandboxHandle,
  path: string,
  isolation?: IsolationInfo,
): Promise<string> {
  if (isolation?.type === 'linux_user' && isolation.linuxUser) {
    const result = await handle.exec(asLinuxUser(isolation.linuxUser, `cat ${shellQuote(path)}`))
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `Failed to read ${path}`)
    }
    return result.stdout
  }
  return handle.readFile(path, isolation)
}

export async function isolatedWrite(
  handle: SandboxHandle,
  path: string,
  content: string,
  isolation?: IsolationInfo,
): Promise<void> {
  if (isolation?.type === 'linux_user' && isolation.linuxUser) {
    const b64 = Buffer.from(content, 'utf-8').toString('base64')
    const cmd = asLinuxUser(
      isolation.linuxUser,
      `mkdir -p "$(dirname ${shellQuote(path)})" && echo ${shellQuote(b64)} | base64 -d > ${shellQuote(path)}`,
    )
    const result = await handle.exec(cmd)
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout || `Failed to write ${path}`)
    }
    return
  }
  await handle.writeFile(path, content, isolation)
}
