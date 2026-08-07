import { createHmac } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

const broker = process.env.BROKER_URL ?? 'http://127.0.0.1:8080'
const secret = process.env.JWT_SECRET ?? 'local-dev-secret'
const sessionId = process.env.SESSION_ID ?? `ws-verify-${Date.now()}`
const alice = sign('alice')
const bob = sign('bob')

const results = []

async function step(name, fn) {
  try {
    const detail = await fn()
    results.push({ name, ok: true, detail })
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    console.error(`FAIL  ${name} — ${error instanceof Error ? error.message : error}`)
  }
}

function sign(userId) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ user_id: userId, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${broker}${path}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  const json = text ? safeJson(text) : undefined
  return { response, text, json }
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

await step('auth rejects missing bearer with public envelope', async () => {
  const { response, json } = await api('/v1/status')
  if (response.status !== 401) throw new Error(`status ${response.status}`)
  if (json?.code !== 'AUTH.REQUIRED' || !json?.ref) throw new Error(JSON.stringify(json))
  return json.code
})

let sandboxId
await step('acquire exclusive workspace', async () => {
  const { response, json } = await api('/v1/leases/acquire', {
    token: alice,
    method: 'POST',
    body: { sessionId },
  })
  if (response.status !== 200 || json?.status !== 'granted') throw new Error(JSON.stringify(json))
  sandboxId = json.sandboxId
  return sandboxId
})

await step('cross-tenant exec forbidden', async () => {
  const { response, json } = await api(`/v1/sandboxes/${sandboxId}/exec`, {
    token: bob,
    method: 'POST',
    body: { command: 'pwd' },
  })
  if (response.status !== 403 || json?.code !== 'AUTH.FORBIDDEN') throw new Error(JSON.stringify(json))
  return json.code
})

const opencode = `/v1/workspaces/${sessionId}/opencode`
await step('opencode health via gateway', async () => {
  for (let i = 0; i < 40; i++) {
    const { response, json } = await api(`${opencode}/api/health`, { token: alice })
    if (response.status === 200 && (json?.healthy === true || json?.status === 'ok' || json)) {
      return JSON.stringify(json)
    }
    await sleep(1500)
  }
  throw new Error('health not ready')
})

let createdSession
await step('create session via gateway', async () => {
  const { response, json, text } = await api(`${opencode}/api/session`, {
    token: alice,
    method: 'POST',
    body: {},
  })
  if (response.status >= 400) throw new Error(`${response.status} ${text.slice(0, 300)}`)
  createdSession = json?.id ?? json?.data?.id
  if (!createdSession) throw new Error(text.slice(0, 300))
  return createdSession
})

await step('SSE emits server.connected (id when fork image is deployed)', async () => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  const response = await fetch(`${broker}${opencode}/api/event`, {
    headers: {
      Authorization: `Bearer ${alice}`,
      'Last-Event-ID': 'evt_ignored_stub',
    },
    signal: controller.signal,
  })
  if (response.status !== 200) throw new Error(`status ${response.status}`)
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error(`content-type ${response.headers.get('content-type')}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      if (buf.includes('server.connected')) break
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'AbortError') throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  if (!buf.includes('server.connected')) throw new Error(`missing server.connected in:\n${buf.slice(0, 400)}`)
  const hasId = /(?:^|\n)id:\s*evt_/.test(buf)
  return hasId ? 'connected+id' : 'connected (SSE id pending fork runtime image rebuild)'
})

await step('release workspace', async () => {
  const { response, json, text } = await api('/v1/leases/release', {
    token: alice,
    method: 'POST',
    body: { sessionId },
  })
  if (response.status >= 400) throw new Error(`${response.status} ${text.slice(0, 300)}`)
  return JSON.stringify(json ?? { ok: true })
})

const failed = results.filter((item) => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)
