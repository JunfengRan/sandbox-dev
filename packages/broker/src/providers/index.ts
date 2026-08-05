import type { SandboxProvider, SandboxProviderName } from '@sandbox-dev/shared'
import type { Config } from '../config.js'
import { AioSandboxProvider } from './aio.js'
import { DaytonaSandboxProvider } from './daytona.js'
import { E2BSandboxProvider } from './e2b.js'

export function createSandboxProvider(config: Config): SandboxProvider {
  switch (config.sandboxProvider) {
    case 'e2b':
      return new E2BSandboxProvider(config)
    case 'aio':
      return new AioSandboxProvider(config)
    case 'daytona':
    default:
      return new DaytonaSandboxProvider(config)
  }
}

export function parseSandboxProvider(value: string | undefined): SandboxProviderName {
  if (value === 'e2b') return 'e2b'
  if (value === 'aio') return 'aio'
  return 'daytona'
}

export { AioSandboxProvider, DaytonaSandboxProvider, E2BSandboxProvider }
