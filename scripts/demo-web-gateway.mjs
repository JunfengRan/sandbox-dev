/**
 * Minimal local demo shim:
 *   browser (packages/app) -> http://127.0.0.1:4096 -> Broker JWT gateway -> sandbox opencode
 *
 * Usage:
 *   node scripts/demo-web-gateway.mjs
 *   # then: cd E:\opencode\packages\app && bun run dev
 */
import { createHmac } from 'node:crypto'
import { createServer, request as httpRequest } from 'node:http'
import { setInterval as every } from 'node:timers'

const broker = process.env.BROKER_URL ?? 'http://127.0.0.1:8080'
const secret = process.env.JWT_SECRET ?? 'local-dev-secret'
const listenPort = Number(process.env.DEMO_PORT ?? 4096)
const userId = process.env.DEMO_USER ?? 'alice'
const sessionId = process.env.DEMO_SESSION ?? `ws-demo-${Date.now()}`
const token = sign(userId)

function sign(subject) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ user_id: subject, exp: Math.floor(Date.now() / 1000) + 6 * 3600 }),
  ).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${broker}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const json = text ? JSON.parse(text) : undefined
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`)
  return json
}

async function upstreamJson(path) {
  const response = await fetch(`${upstreamBase}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Accept-Encoding': 'identity',
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`GET ${path} -> ${response.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}

function jsonResponse(res, origin, body, status = 200) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
  })
  res.end(payload)
}

function parseModelRef(value) {
  if (typeof value !== 'string' || !value.includes('/')) return undefined
  const i = value.indexOf('/')
  return { providerID: value.slice(0, i), id: value.slice(i + 1) }
}

function customProvidersFromConfig(config) {
  const providers = config?.provider
  if (!providers || typeof providers !== 'object') return []
  return Object.entries(providers).flatMap(([id, provider]) => {
    if (!provider || typeof provider !== 'object') return []
    const apiKey =
      typeof provider.options?.apiKey === 'string' && !provider.options.apiKey.startsWith('{')
        ? provider.options.apiKey
        : 'configured'
    const baseURL = typeof provider.options?.baseURL === 'string' ? provider.options.baseURL : undefined
    return [
      {
        id,
        name: typeof provider.name === 'string' ? provider.name : id,
        api: {
          type: 'aisdk',
          package: typeof provider.npm === 'string' ? provider.npm : '@ai-sdk/openai-compatible',
          ...(baseURL ? { url: baseURL } : {}),
          settings: {},
        },
        // Catalog.available() only treats providers with request.body.apiKey as connected.
        request: { headers: {}, body: { apiKey } },
      },
    ]
  })
}

function customModelsFromConfig(config) {
  const providers = config?.provider
  if (!providers || typeof providers !== 'object') return []
  const released = Date.now()
  return Object.entries(providers).flatMap(([providerID, provider]) => {
    if (!provider?.models || typeof provider.models !== 'object') return []
    const apiKey =
      typeof provider.options?.apiKey === 'string' && !provider.options.apiKey.startsWith('{')
        ? provider.options.apiKey
        : 'configured'
    const baseURL = typeof provider.options?.baseURL === 'string' ? provider.options.baseURL : ''
    const npm = typeof provider.npm === 'string' ? provider.npm : '@ai-sdk/openai-compatible'
    return Object.entries(provider.models).map(([id, model]) => ({
      id,
      providerID,
      family: id,
      name: typeof model?.name === 'string' ? model.name : id,
      api: {
        id,
        type: 'aisdk',
        package: npm,
        url: baseURL,
      },
      capabilities: { tools: true, input: ['text'], output: ['text'] },
      request: { headers: {}, body: { apiKey } },
      variants: [],
      time: { released },
      cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
      status: 'active',
      enabled: true,
      limit: { context: 128000, output: 8192 },
    }))
  })
}

async function handleCatalogGet(pathOnly, origin, res) {
  if (pathOnly === '/api/model/default') {
    const config = await upstreamJson('/config')
    const ref = parseModelRef(config?.model)
    if (!ref) {
      jsonResponse(res, origin, { data: null })
      return
    }
    const models = customModelsFromConfig(config)
    const match = models.find((item) => item.providerID === ref.providerID && item.id === ref.id)
    jsonResponse(res, origin, { data: match ?? { id: ref.id, providerID: ref.providerID } })
    return
  }

  if (pathOnly === '/api/provider') {
    const [listed, config] = await Promise.all([upstreamJson('/api/provider'), upstreamJson('/config')])
    const existing = new Set((listed?.data ?? []).map((item) => item.id))
    const extras = customProvidersFromConfig(config).filter((item) => !existing.has(item.id))
    jsonResponse(res, origin, {
      ...listed,
      data: [...(listed?.data ?? []), ...extras],
    })
    return
  }

  if (pathOnly === '/api/model') {
    const [listed, config] = await Promise.all([upstreamJson('/api/model'), upstreamJson('/config')])
    const existing = new Set((listed?.data ?? []).map((item) => `${item.providerID}/${item.id}`))
    const extras = customModelsFromConfig(config).filter((item) => !existing.has(`${item.providerID}/${item.id}`))
    jsonResponse(res, origin, {
      ...listed,
      data: [...extras, ...(listed?.data ?? [])],
    })
  }
}

console.log(`Acquiring workspace ${sessionId} as ${userId}...`)
let lease = await api('/v1/leases/acquire', { method: 'POST', body: { sessionId } })
for (let i = 0; lease.status === 'queued' && i < 60; i++) {
  console.log(`queued position=${lease.queuePosition}; waiting...`)
  await new Promise((r) => setTimeout(r, 2000))
  lease = await api(`/v1/leases/poll?ticketId=${encodeURIComponent(lease.ticketId)}`)
}
if (lease.status !== 'granted') throw new Error(`acquire failed: ${JSON.stringify(lease)}`)
console.log(`Granted sandbox ${lease.sandboxId}`)

const upstreamBase = `${broker}/v1/workspaces/${encodeURIComponent(sessionId)}/opencode`
for (let i = 0; i < 40; i++) {
  const health = await fetch(`${upstreamBase}/api/health`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (health.ok) {
    console.log('OpenCode health ready')
    break
  }
  await new Promise((r) => setTimeout(r, 1500))
  if (i === 39) throw new Error('OpenCode health timeout')
}

every(() => {
  void api('/v1/leases/heartbeat', { method: 'POST', body: { sessionId } }).catch((error) => {
    console.warn('heartbeat failed', error.message)
  })
}, 30_000)

const hopByHop = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
])

const catalogPaths = new Set(['/api/provider', '/api/model', '/api/model/default'])

const server = createServer((req, res) => {
  const origin = req.headers.origin ?? '*'
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Max-Age': '86400',
    })
    res.end()
    return
  }

  const pathOnly = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && catalogPaths.has(pathOnly)) {
    void handleCatalogGet(pathOnly, origin, res).catch((error) => {
      if (!res.headersSent) {
        jsonResponse(res, origin, { error: error.message }, 502)
      }
    })
    return
  }

  const target = new URL(upstreamBase.replace(/\/$/, '') + (req.url ?? '/'))
  const headers = { ...req.headers, authorization: `Bearer ${token}`, host: target.host }
  for (const key of hopByHop) delete headers[key]

  const proxy = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (upstream) => {
      const out = { ...upstream.headers }
      out['access-control-allow-origin'] = origin
      out['access-control-allow-credentials'] = 'true'
      // Keep content-encoding when piping raw bytes; do not decompress here.
      res.writeHead(upstream.statusCode ?? 502, out)
      upstream.pipe(res)
    },
  )
  proxy.on('error', (error) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  })
  req.pipe(proxy)
})

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`
Demo gateway ready
  local:   http://127.0.0.1:${listenPort}
  upstream:${upstreamBase}
  session: ${sessionId}

Next:
  cd E:\\opencode\\packages\\app
  bun run dev

packages/app 默认会连 localhost:4096，打开后应直接看到沙箱内 OpenCode。
Ctrl+C 时会 release 租约。
`)
})

async function shutdown() {
  console.log('\nReleasing lease...')
  try {
    await api('/v1/leases/release', { method: 'POST', body: { sessionId } })
  } catch (error) {
    console.warn(error.message)
  }
  process.exit(0)
}

process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
