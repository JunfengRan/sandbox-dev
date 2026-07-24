import type { SandboxProvider, SandboxProviderName } from '@sandbox-dev/shared'
import type { Config } from '../config.js'
import { DaytonaSandboxProvider } from './daytona.js'
import { E2BSandboxProvider } from './e2b.js'

export function createSandboxProvider(config: Config): SandboxProvider {
  switch (config.sandboxProvider) {
    case 'e2b':
      return new E2BSandboxProvider(config)
    case 'daytona':
    default:
      return new DaytonaSandboxProvider(config)
  }
}

export function parseSandboxProvider(value: string | undefined): SandboxProviderName {
  return value === 'e2b' ? 'e2b' : 'daytona'
}

export { DaytonaSandboxProvider, E2BSandboxProvider }
