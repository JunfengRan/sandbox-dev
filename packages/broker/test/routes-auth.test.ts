import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createServer, request as createServerRequest } from 'node:http'
import { after, before, test } from 'node:test'
import { loadConfig } from '../src/config.js'
import { createApp, signUserToken } from '../src/api/routes.js'
import type { BrokerService } from '../src/api/broker-service.js'

const calls: string[] = []
const upstreamHeaders: Array<Record<string, string | string[] | undefined>> = []
let upstreamUrl: string
let endpointHeaders: Record<string, string> | undefined
const broker = {
  acquire: async (request: { userId: string; sessionId: string }) => {
    calls.push(`acquire:${request.userId}:${request.sessionId}`)
    return { status: 'granted' as const, sandboxId: 'sandbox-1' }
  },
  status: async (userId: string) => {
    calls.push(`status:${userId}`)
    return { leases: [] }
  },
  execInSandbox: async (userId: string, sandboxId: string, command: string) => {
    calls.push(`exec:${userId}:${sandboxId}:${command}`)
    return { exitCode: 0, stdout: '', stderr: '' }
  },
  getOpenCodeEndpoint: async (userId: string, sessionId: string) => {
    calls.push(`proxy:${userId}:${sessionId}`)
    return {
      url: upstreamUrl,
      authorization: 'Basic internal-service-secret',
      headers: endpointHeaders,
    }
  },
} as unknown as BrokerService

const secret = 'route-test-secret'
let server: Server
let upstream: Server
let baseUrl: string

before(async () => {
  upstream = createServer((request, response) => {
    upstreamHeaders.push({
      authorization: request.headers.authorization,
      'last-event-id': request.headers['last-event-id'],
    })
    if (request.url?.includes('/api/event')) {
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
      })
      response.write('id: evt_test\nevent: message\ndata: {"type":"server.connected"}\n\n')
      response.end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ authorization: request.headers.authorization }))
  }).listen(0)
  await new Promise<void>((resolve) => upstream.once('listening', resolve))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  server = createApp({ ...loadConfig(), jwtSecret: secret }, broker).listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

after(async () => {
  await Promise.all(
    [server, upstream].map(
      (item) =>
        new Promise<void>((resolve, reject) => {
          item.close((error) => (error ? reject(error) : resolve()))
        }),
    ),
  )
})

test('rejects protected routes without a bearer token', async () => {
  const response = await fetch(`${baseUrl}/v1/status`)

  assert.equal(response.status, 401)
  const body = await response.json()
  assert.equal(body.code, 'AUTH.REQUIRED')
  assert.equal(body.message, 'Authentication required')
  assert.equal(body.retryable, false)
  assert.match(body.ref, /^err_[a-f0-9]{12}$/)
})

test('uses the JWT subject instead of a body userId', async () => {
  calls.length = 0
  const response = await fetch(`${baseUrl}/v1/leases/acquire`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signUserToken('alice', secret)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ userId: 'bob', sessionId: 'session-1' }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(calls, ['acquire:alice:session-1'])
})

test('passes the authenticated owner to sandbox operations', async () => {
  calls.length = 0
  const response = await fetch(`${baseUrl}/v1/sandboxes/sandbox-1/exec`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signUserToken('alice', secret)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ command: 'pwd' }),
  })

  assert.equal(response.status, 200)
  assert.deepEqual(calls, ['exec:alice:sandbox-1:pwd'])
})

test('proxies OpenCode with internal credentials for the authenticated workspace', async () => {
  calls.length = 0
  const response = await fetch(
    `${baseUrl}/v1/workspaces/session-1/opencode/api/health`,
    {
      headers: { Authorization: `Bearer ${signUserToken('alice', secret)}` },
    },
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    authorization: 'Basic internal-service-secret',
  })
  assert.deepEqual(calls, ['proxy:alice:session-1'])
})

test('strips Expect before proxying OpenCode POST bodies', async () => {
  calls.length = 0
  const url = new URL(`${baseUrl}/v1/workspaces/session-1/opencode/api/session`)
  const body = Buffer.from('{}')
  const { statusCode, payload } = await new Promise<{ statusCode: number; payload: string }>(
    (resolve, reject) => {
      const request = createServerRequest(
        {
          hostname: url.hostname,
          port: Number(url.port),
          path: url.pathname,
          method: 'POST',
          headers: {
            Authorization: `Bearer ${signUserToken('alice', secret)}`,
            'Content-Type': 'application/json',
            'Content-Length': String(body.byteLength),
            Expect: '100-continue',
          },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          response.on('end', () =>
            resolve({
              statusCode: response.statusCode ?? 0,
              payload: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      request.on('error', reject)
      request.on('continue', () => request.end(body))
      // Some Node versions emit continue; if not, write after a tick.
      setTimeout(() => {
        if (!request.destroyed && !request.writableEnded) request.end(body)
      }, 20)
    },
  )

  assert.equal(statusCode, 200)
  assert.deepEqual(JSON.parse(payload), {
    authorization: 'Basic internal-service-secret',
  })
  assert.deepEqual(calls, ['proxy:alice:session-1'])
})

test('forwards Last-Event-ID and SSE framing for OpenCode event streams', async () => {
  calls.length = 0
  upstreamHeaders.length = 0
  const response = await fetch(`${baseUrl}/v1/workspaces/session-1/opencode/api/event`, {
    headers: {
      Authorization: `Bearer ${signUserToken('alice', secret)}`,
      'Last-Event-ID': 'evt_prior',
    },
  })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform')
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  const body = await response.text()
  assert.match(body, /id: evt_test/)
  assert.match(body, /server\.connected/)
  assert.deepEqual(calls, ['proxy:alice:session-1'])
  assert.equal(upstreamHeaders.at(-1)?.['last-event-id'], 'evt_prior')
  assert.equal(upstreamHeaders.at(-1)?.authorization, 'Basic internal-service-secret')
})

test('preserves gzip encoding on Host-header raw OpenCode proxy', async () => {
  calls.length = 0
  endpointHeaders = { host: 'preview.example.localhost' }
  const payload = { ok: true, models: ['deepseek'] }
  const previousListeners = upstream.listeners('request')
  upstream.removeAllListeners('request')
  upstream.on('request', (_request, response) => {
    const body = gzipSync(JSON.stringify(payload))
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-encoding': 'gzip',
      'content-length': String(body.byteLength),
    })
    response.end(body)
  })

  try {
    const response = await fetch(`${baseUrl}/v1/workspaces/session-1/opencode/api/model`, {
      headers: { Authorization: `Bearer ${signUserToken('alice', secret)}` },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), payload)
    assert.deepEqual(calls, ['proxy:alice:session-1'])
  } finally {
    endpointHeaders = undefined
    upstream.removeAllListeners('request')
    for (const listener of previousListeners) upstream.on('request', listener as never)
  }
})
