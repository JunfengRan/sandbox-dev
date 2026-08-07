import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DaytonaNotFoundError } from '@daytona/sdk'
import { loadConfig } from '../src/config.js'
import { DaytonaSandboxProvider } from '../src/providers/daytona.js'

test('starts and stops a Daytona service through a private preview endpoint', async () => {
  const calls: string[] = []
  const sandbox = {
    id: 'sandbox-1',
    state: 'started',
    process: {
      getSession: async (id: string) => {
        calls.push(`get:${id}`)
        throw new DaytonaNotFoundError('missing')
      },
      createSession: async (id: string) => {
        calls.push(`create:${id}`)
      },
      executeSessionCommand: async (
        id: string,
        request: { command: string; runAsync?: boolean },
      ) => {
        calls.push(`execute:${id}:${request.runAsync}:${request.command}`)
        return { cmdId: 'command-1' }
      },
      deleteSession: async (id: string) => {
        calls.push(`delete:${id}`)
      },
    },
    getSignedPreviewUrl: async (port: number, expiresInSeconds?: number) => {
      calls.push(`preview:${port}:${expiresInSeconds}`)
      return {
        sandboxId: 'sandbox-1',
        port,
        token: 'private',
        url: 'https://preview.internal/?token=private',
      }
    },
  }
  const daytona = {
    get: async (id: string) => {
      assert.equal(id, 'sandbox-1')
      return sandbox
    },
  }
  const request = async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    assert.equal(String(input), 'https://preview.internal/api/health?token=private')
    assert.deepEqual(init?.headers, {})
    return new Response(null, { status: 200 })
  }
  const provider = new DaytonaSandboxProvider(loadConfig(), daytona, request)

  const service = await provider.startService('sandbox-1', {
    name: 'opencode',
    command: 'opencode serve --hostname 0.0.0.0 --port 4096',
    port: 4096,
    cwd: '/workspace',
    env: { OPENCODE_SERVER_PASSWORD: 'secret' },
    healthPath: '/api/health',
    readinessTimeoutMs: 100,
  })

  assert.equal(service.state, 'ready')
  assert.equal(service.endpoint?.scope, 'provider-internal')
  assert.match(service.endpoint?.url ?? '', /^https:\/\/preview\.internal/)
  assert.ok(service.endpoint?.expiresAt)
  assert.deepEqual(calls.slice(0, 4), [
    'get:service-opencode',
    'create:service-opencode',
    "execute:service-opencode:true:cd '/workspace' && export OPENCODE_SERVER_PASSWORD='secret' && opencode serve --hostname 0.0.0.0 --port 4096",
    'preview:4096:3600',
  ])

  const endpoint = await provider.getServiceEndpoint('sandbox-1', 'opencode')
  assert.equal(endpoint.scope, 'provider-internal')
  assert.equal(calls.at(-1), 'preview:4096:3600')

  const stopped = await provider.stopService('sandbox-1', 'opencode')
  assert.deepEqual(stopped, { name: 'opencode', state: 'stopped' })
  assert.equal(calls.at(-1), 'delete:service-opencode')
})

test('rewrites Daytona proxy.localhost previews to loopback with Host header', async () => {
  const { rewriteDaytonaPreviewEndpoint } = await import('../src/providers/daytona.js')
  const rewritten = rewriteDaytonaPreviewEndpoint({
    url: 'http://4096-token.proxy.localhost:4000',
    scope: 'provider-internal',
  })
  assert.equal(rewritten.url, 'http://127.0.0.1:4000')
  assert.deepEqual(rewritten.headers, { host: '4096-token.proxy.localhost:4000' })
})
