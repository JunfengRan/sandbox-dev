/**
 * Inject local DeepSeek + agent settings into the active demo sandbox OpenCode.
 * Secrets stay in gitignored files / process env — never written into the repo.
 *
 * Usage:
 *   node scripts/demo-inject-model-config.mjs
 */
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const broker = process.env.BROKER_URL ?? 'http://127.0.0.1:8080'
const secret = process.env.JWT_SECRET ?? 'local-dev-secret'
const userId = process.env.DEMO_USER ?? 'alice'
const serverPassword = process.env.OPENCODE_SERVER_PASSWORD ?? 'probe-secret'
const demoConfigPath = join(root, 'deploy/local/opencode.demo.json')
const secretsPath = join(root, 'deploy/local/.env.demo.secrets')
const localConfigPath = join(homedir(), '.config/opencode/opencode.json')

function sign(subject) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ user_id: subject, exp: Math.floor(Date.now() / 1000) + 3600 }),
  ).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}

function loadDotEnv(path) {
  if (!existsSync(path)) return {}
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const i = line.indexOf('=')
        return [line.slice(0, i), line.slice(i + 1)]
      }),
  )
}

function resolveDeepseekKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim()
  const fromSecrets = loadDotEnv(secretsPath).DEEPSEEK_API_KEY?.trim()
  if (fromSecrets) return fromSecrets
  if (!existsSync(localConfigPath)) {
    throw new Error(
      `No DeepSeek key found. Set DEEPSEEK_API_KEY, or create ${secretsPath} from .env.demo.secrets.example`,
    )
  }
  const local = JSON.parse(readFileSync(localConfigPath, 'utf8'))
  const key = local?.provider?.deepseek?.options?.apiKey
  if (typeof key !== 'string' || !key.trim()) {
    throw new Error(`No provider.deepseek.options.apiKey in ${localConfigPath}`)
  }
  mkdirSync(dirname(secretsPath), { recursive: true })
  if (!existsSync(secretsPath)) {
    writeFileSync(secretsPath, `DEEPSEEK_API_KEY=${key.trim()}\n`, { encoding: 'utf8', mode: 0o600 })
    console.log(`Wrote gitignored ${secretsPath}`)
  }
  return key.trim()
}

async function api(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${broker}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : undefined
}

async function exec(token, sandboxId, command) {
  return api(`/v1/sandboxes/${sandboxId}/exec`, {
    token,
    method: 'POST',
    body: { command, cwd: '/home/user/project' },
  })
}

async function main() {
  const token = sign(userId)
  const apiKey = resolveDeepseekKey()
  const status = await api('/v1/status', { token })
  const lease = status.leases?.[0]
  if (!lease) throw new Error('No active lease. Start scripts/demo-web-gateway.mjs first.')

  const demoConfig = JSON.parse(readFileSync(demoConfigPath, 'utf8'))
  // Inline key in the sandbox-only config: v2 /api/provider.available() does not resolve {file:}
  // the same way legacy /config/providers does, so the model picker would omit DeepSeek.
  demoConfig.provider.deepseek.options.apiKey = apiKey
  const configB64 = Buffer.from(JSON.stringify(demoConfig, null, 2)).toString('base64')
  const keyB64 = Buffer.from(apiKey).toString('base64')
  const passwordB64 = Buffer.from(serverPassword).toString('base64')
  const marker = randomBytes(4).toString('hex')

  console.log(`Injecting demo config into sandbox ${lease.sandboxId} (session ${lease.sessionId})`)
  console.log('Model: deepseek/deepseek-v4-flash ; agents: build, plan')

  const script = `#!/bin/sh
set -e
mkdir -p /home/user/.config/opencode /home/user/project
echo '${keyB64}' | base64 -d > /home/user/.config/opencode/.deepseek_key
chmod 600 /home/user/.config/opencode/.deepseek_key
echo '${passwordB64}' | base64 -d > /home/user/.config/opencode/.server_password
chmod 600 /home/user/.config/opencode/.server_password
echo '${configB64}' | base64 -d > /home/user/.config/opencode/opencode.json
cp /home/user/.config/opencode/opencode.json /home/user/project/opencode.json
pkill -f 'opencode serve' || true
sleep 1
export HOME=/home/user
export OPENCODE_SERVER_PASSWORD="$(cat /home/user/.config/opencode/.server_password)"
cd /home/user/project
nohup opencode serve --hostname 0.0.0.0 --port 4096 >/tmp/opencode-serve.log 2>&1 &
sleep 3
curl -fsS -u "opencode:$OPENCODE_SERVER_PASSWORD" http://127.0.0.1:4096/api/health
echo
echo DEMO_INJECT_OK_${marker}
`

  const scriptB64 = Buffer.from(script).toString('base64')
  const result = await exec(
    token,
    lease.sandboxId,
    `echo '${scriptB64}' | base64 -d > /tmp/demo-inject.sh && chmod +x /tmp/demo-inject.sh && /bin/sh /tmp/demo-inject.sh`,
  )

  const ok = typeof result.stdout === 'string' && result.stdout.includes(`DEMO_INJECT_OK_${marker}`)
  if (!ok) {
    console.error('Inject failed (exitCode=%s). Check /tmp/opencode-serve.log in sandbox.', result.exitCode)
    throw new Error('sandbox inject failed')
  }
  console.log('Sandbox OpenCode restarted with demo config')

  for (let i = 0; i < 20; i++) {
    const health = await fetch('http://127.0.0.1:4096/api/health')
    if (!health.ok) {
      await new Promise((r) => setTimeout(r, 1000))
      continue
    }
    const models = await fetch('http://127.0.0.1:4096/api/provider').then(async (r) => ({
      status: r.status,
      body: (await r.text()).slice(0, 800),
    }))
    console.log('Gateway health OK')
    console.log('Provider list status:', models.status)
    if (models.body.toLowerCase().includes('deepseek')) console.log('DeepSeek provider is visible')
    console.log('\nIn the web UI: Select model -> DeepSeek V4 Flash')
    console.log('Config paths:')
    console.log('  template (safe to commit): deploy/local/opencode.demo.json')
    console.log('  secrets (gitignored):      deploy/local/.env.demo.secrets')
    console.log('  sandbox runtime config:    /home/user/.config/opencode/opencode.json')
    return
  }
  throw new Error('OpenCode did not become healthy after restart')
}

await main()
