import type { IsolationInfo } from '@sandbox-dev/shared'
import { asLinuxUser, shellQuote } from '@sandbox-dev/shared'

export function wrapCommand(command: string, isolation: IsolationInfo): string {
  const cwd = isolation.workDir

  switch (isolation.type) {
    case 'linux_user':
      if (isolation.linuxUser) {
        return asLinuxUser(isolation.linuxUser, `mkdir -p ${cwd} && cd ${cwd} && ${command}`)
      }
      break
    case 'bubblewrap':
      return [
        'bwrap',
        '--unshare-user',
        '--die-with-parent',
        `--bind ${cwd} /work`,
        '--dev /dev',
        '--',
        'bash',
        '-lc',
        shellQuote(command),
      ].join(' ')
    case 'session_dir':
      return `mkdir -p ${cwd} && cd ${cwd} && ${command}`
    default:
      return command
  }

  return command
}

export function wrapBubblewrapFallback(command: string, userId: string, sessionId: string): string {
  const userDir = `/home/daytona/project/users/${userId}/sessions/${sessionId}`
  return [
    'bwrap',
    '--unshare-user',
    '--die-with-parent',
    `--bind ${userDir} /work`,
    '--dev /dev',
    '--',
    'bash',
    '-lc',
    shellQuote(`mkdir -p /work && cd /work && ${command}`),
  ].join(' ')
}

export async function detectIsolationBackend(
  sandboxId: string,
  getSandbox: (id: string) => Promise<{ process: { executeCommand: (cmd: string) => Promise<{ exitCode: number; result: string }> } }>,
): Promise<'linux_user' | 'bubblewrap'> {
  const sandbox = await getSandbox(sandboxId)
  const sudoProbe = await sandbox.process.executeCommand('sudo -u ocuser_001 id -u 2>/dev/null || echo fail')
  if (sudoProbe.result.includes('1001')) return 'linux_user'
  const bwrap = await sandbox.process.executeCommand('command -v bwrap >/dev/null 2>&1 && echo yes || echo no')
  if (bwrap.result.includes('yes')) return 'bubblewrap'
  return 'bubblewrap'
}
