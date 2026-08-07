import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import { createRuntimeApp } from '../src/routes.js'
import {
  makeServiceStartCommand,
  sandboxNetwork,
  waitForServiceReady,
  type DockerSandboxManager,
} from '../src/docker-manager.js'

const calls: string[] = []
let upstreamUrl = 'http://172.18.0.2:4096'
const manager = {
  getBackend: () => 'e2b' as const,
  startService: async (sandboxId: string, service: { name: string }) => {
    calls.push(`start:${sandboxId}:${service.name}`)
    return {
      name: service.name,
      state: 'ready' as const,
      endpoint: {
        url: upstreamUrl,
        scope: 'provider-internal' as const,
      },
    }
  },
  getServiceEndpoint: async (sandboxId: string, name: string) => {
    calls.push(`endpoint:${sandboxId}:${name}`)
    return {
      url: upstreamUrl,
      scope: 'provider-internal' as const,
    }
  },
  stopService: async (sandboxId: string, name: string) => {
    calls.push(`stop:${sandboxId}:${name}`)
    return { name, state: 'stopped' as const }
  },
} as unknown as DockerSandboxManager

let server: Server
let baseUrl: string

before(async () => {
  server = createRuntimeApp(manager).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

test('starts a named service and returns only its provider-internal endpoint', async () => {
  calls.length = 0
  const response = await fetch(`${baseUrl}/v1/sandboxes/sbx-1/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'opencode',
      command: 'opencode serve --port 4096',
      port: 4096,
      cwd: '/workspace',
      env: { OPENCODE_CONFIG: '/workspace/opencode.json' },
      healthPath: '/global/health',
      readinessTimeoutMs: 1000,
    }),
  })

  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), {
    name: 'opencode',
    state: 'ready',
    endpoint: {
      url: `${baseUrl}/v1/sandboxes/sbx-1/services/opencode/proxy`,
      scope: 'provider-internal',
    },
  })
  assert.deepEqual(calls, ['start:sbx-1:opencode'])
})

test('rejects invalid service parameters before invoking the manager', async () => {
  calls.length = 0
  const response = await fetch(`${baseUrl}/v1/sandboxes/sbx-1/services`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '../bad', command: '', port: 70000, healthPath: 'health' }),
  })

  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.code, 'RUNTIME.BAD_REQUEST')
  assert.equal(body.retryable, false)
  assert.match(body.ref, /^err_[a-f0-9]{12}$/)
  assert.equal(typeof body.message, 'string')
  assert.deepEqual(calls, [])
})

test('gets an upstream endpoint with explicit provider-internal scope', async () => {
  calls.length = 0
  const response = await fetch(`${baseUrl}/v1/sandboxes/sbx-1/services/opencode/endpoint`)

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    url: `${baseUrl}/v1/sandboxes/sbx-1/services/opencode/proxy`,
    scope: 'provider-internal',
  })
  assert.deepEqual(calls, ['endpoint:sbx-1:opencode'])
})

test('stops a service and omits its former endpoint', async () => {
  calls.length = 0
  const response = await fetch(`${baseUrl}/v1/sandboxes/sbx-1/services/opencode`, {
    method: 'DELETE',
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { name: 'opencode', state: 'stopped' })
  assert.deepEqual(calls, ['stop:sbx-1:opencode'])
})

test('readiness fails with a bounded timeout', async () => {
  const unavailable = async () => new Response('not ready', { status: 503 })

  await assert.rejects(
    waitForServiceReady('http://service.internal:4096', '/health', 10, unavailable, 1),
    /Service readiness timed out after 10ms: HTTP 503/,
  )
})

test('readiness forwards private health headers', async () => {
  const request = async (_input: string | URL | globalThis.Request, init?: RequestInit) => {
    assert.equal(new Headers(init?.headers).get('authorization'), 'Basic private')
    return new Response(null, { status: 200 })
  }

  await waitForServiceReady(
    'http://service.internal:4096',
    '/api/health',
    10,
    request,
    1,
    { Authorization: 'Basic private' },
  )
})

test('readiness aborts a stalled connection within the total timeout', async () => {
  const stalled = async (_input: string | URL | globalThis.Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
    })
  const result = await Promise.race([
    waitForServiceReady('http://service.internal:4096', '/api/health', 10, stalled, 1).then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('outer-timeout'), 100)),
  ])

  assert.equal(result, 'rejected')
})

test('builds a valid background command without an ampersand-semicolon sequence', () => {
  const command = makeServiceStartCommand({
    name: 'opencode',
    command: 'opencode serve --port 4096',
    port: 4096,
    env: { TOKEN: 'private value' },
  })

  assert.doesNotMatch(command, /&;/)
  assert.match(command, /& echo \$! >/)
  assert.match(command, /TOKEN='private value'/)
})

test('places E2B-compatible services on the runtime-accessible sandbox network', () => {
  assert.equal(sandboxNetwork('e2b', 'sandbox-dev-aio'), 'sandbox-dev-aio')
  assert.equal(sandboxNetwork('aio', 'sandbox-dev-aio'), 'sandbox-dev-aio')
})

test('proxies an SSE stream without exposing the container endpoint', async () => {
  const upstream = createRuntimeApp(manager).listen(0)
  await new Promise<void>((resolve) => upstream.once('listening', resolve))
  const address = upstream.address() as AddressInfo
  upstreamUrl = `http://127.0.0.1:${address.port}`
  upstream.removeAllListeners('request')
  upstream.on('request', (_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    })
    response.end('data: {"type":"server.connected"}\n\n')
  })

  try {
    const response = await fetch(
      `${baseUrl}/v1/sandboxes/sbx-1/services/opencode/proxy/api/event`,
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/event-stream')
    assert.equal(await response.text(), 'data: {"type":"server.connected"}\n\n')
  } finally {
    upstreamUrl = 'http://172.18.0.2:4096'
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()))
    })
  }
})

test('removes stale compression metadata after upstream decompression', async () => {
  const upstream = createRuntimeApp(manager).listen(0)
  await new Promise<void>((resolve) => upstream.once('listening', resolve))
  const address = upstream.address() as AddressInfo
  upstreamUrl = `http://127.0.0.1:${address.port}`
  upstream.removeAllListeners('request')
  upstream.on('request', (_request, response) => {
    const body = gzipSync(JSON.stringify({ openapi: '3.1.0' }))
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(body.byteLength),
    })
    response.end(body)
  })

  try {
    const response = await fetch(
      `${baseUrl}/v1/sandboxes/sbx-1/services/opencode/proxy/doc`,
    )

    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-encoding'), null)
    assert.deepEqual(await response.json(), { openapi: '3.1.0' })
  } finally {
    upstreamUrl = 'http://172.18.0.2:4096'
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()))
    })
  }
})
