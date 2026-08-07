/**
 * Smoke-test remote write + pull-to-host for demo.
 * Writes a markdown file in the sandbox, then runs demo-pull-md.mjs logic once.
 */
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const broker = process.env.BROKER_URL ?? 'http://127.0.0.1:8080'
const envPath = join(root, 'deploy/local/.env')
const secret =
  process.env.JWT_SECRET?.trim() ||
  (existsSync(envPath)
    ? Object.fromEntries(
        readFileSync(envPath, 'utf8')
          .split(/\r?\n/)
          .filter((l) => l && !l.startsWith('#'))
          .map((l) => {
            const i = l.indexOf('=')
            return [l.slice(0, i), l.slice(i + 1)]
          }),
      ).JWT_SECRET
    : null) ||
  'local-dev-secret'
const userId = process.env.DEMO_USER ?? 'alice'
const outDir = join(root, 'demo-output')

function sign(subject) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ user_id: subject, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${broker}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${sign(userId)}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 240)}`)
  return text ? JSON.parse(text) : undefined
}

const gatewayHealth = await fetch('http://127.0.0.1:4096/api/health')
console.log('gateway /api/health', gatewayHealth.status)

const status = await api('/v1/status')
const lease = status.leases?.[0]
if (!lease) throw new Error('No active lease')
console.log('lease', lease.sessionId, lease.sandboxId)

const stamp = new Date().toISOString()
const content = `# Demo from cloud sandbox\n\nWritten at ${stamp}\n\nRemote R/W OK.\n`
const b64 = Buffer.from(content).toString('base64')
const write = await api(`/v1/sandboxes/${lease.sandboxId}/exec`, {
  method: 'POST',
  body: {
    cwd: '/home/user/project',
    command: [
      'mkdir -p /home/user/project/demo',
      `echo '${b64}' | base64 -d > /home/user/project/demo/hello-from-cloud.md`,
      'ls -la /home/user/project/demo',
      'wc -c /home/user/project/demo/hello-from-cloud.md',
    ].join(' && '),
  },
})
console.log('remote write exit', write.exitCode)
console.log(String(write.stdout || write.stderr || '').slice(0, 400))
if (write.exitCode !== 0) throw new Error('remote write failed')

// Remote read via Broker exec (same path Agent tools use inside the sandbox FS).
const readBack = await api(`/v1/sandboxes/${lease.sandboxId}/exec`, {
  method: 'POST',
  body: {
    cwd: '/home/user/project',
    command: 'cat /home/user/project/demo/hello-from-cloud.md',
  },
})
console.log('remote read ok', String(readBack.stdout || '').includes('Remote R/W OK'))

const pull = spawnSync(process.execPath, [join(root, 'scripts/demo-pull-md.mjs')], {
  cwd: root,
  encoding: 'utf8',
})
console.log(pull.stdout)
if (pull.status !== 0) {
  console.error(pull.stderr)
  throw new Error('pull failed')
}

const hostFile = join(outDir, 'demo', 'hello-from-cloud.md')
if (!existsSync(hostFile)) throw new Error(`missing host file ${hostFile}`)
const hostContent = readFileSync(hostFile, 'utf8')
if (!hostContent.includes('Remote R/W OK')) throw new Error('host content mismatch')
console.log('HOST OK:', hostFile)
console.log(hostContent)
