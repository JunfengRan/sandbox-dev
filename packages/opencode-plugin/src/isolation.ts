import type { IsolationInfo } from '@sandbox-dev/shared'
import { asLinuxUser, shellQuote } from '@sandbox-dev/shared'

export function wrapCommand(command: string, isolation?: IsolationInfo): string {
  if (!isolation || isolation.type === 'none') return command

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
  }

  return command
}

export function resolveSandboxPath(filePath: string, isolation?: IsolationInfo): string {
  if (!isolation || isolation.type === 'none') return filePath
  if (filePath.startsWith('/')) return filePath
  return `${isolation.workDir}/${filePath.replace(/^\.\//, '')}`
}
