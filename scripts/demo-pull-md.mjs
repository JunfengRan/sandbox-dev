/**
 * Pull markdown files from the active demo sandbox workspace onto the host.
 *
 * Usage:
 *   node scripts/demo-pull-md.mjs
 *   node scripts/demo-pull-md.mjs --watch          # poll every 5s
 *   node scripts/demo-pull-md.mjs --out E:\path
 *
 * Source (sandbox): /home/user/project (all .md files, recursive)
 * Dest (host):      E:\sandbox-dev\demo-output\  (gitignored)
 */
import { createHmac } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const broker = process.env.BROKER_URL ?? 'http://127.0.0.1:8080'
const userId = process.env.DEMO_USER ?? 'alice'
const sandboxRoot = process.env.DEMO_SANDBOX_WORKDIR ?? '/home/user/project'
const args = process.argv.slice(2)
const watch = args.includes('--watch')
const outIdx = args.indexOf('--out')
const outDir =
  outIdx >= 0 && args[outIdx + 1]
    ? args[outIdx + 1]
    : process.env.DEMO_OUTPUT_DIR ?? join(root, 'demo-output')
const intervalMs = Number(process.env.DEMO_SYNC_INTERVAL_MS ?? 5000)

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

const secret =
  process.env.JWT_SECRET?.trim() ||
  loadDotEnv(join(root, 'deploy/local/.env')).JWT_SECRET?.trim() ||
  'local-dev-secret'

function sign(subject) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({ user_id: subject, exp: Math.floor(Date.now() / 1000) + 6 * 3600 }),
  ).toString('base64url')
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
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
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 240)}`)
  return text ? JSON.parse(text) : undefined
}

async function exec(token, sandboxId, command) {
  return api(`/v1/sandboxes/${sandboxId}/exec`, {
    token,
    method: 'POST',
    body: { command, cwd: sandboxRoot },
  })
}

async function pullOnce() {
  const token = sign(userId)
  const status = await api('/v1/status', { token })
  const lease = status.leases?.[0]
  if (!lease) throw new Error('No active lease. Start scripts/demo-web-gateway.mjs first.')

  mkdirSync(outDir, { recursive: true })

  // Shell-only: list markdown paths, then emit RECORD/path + base64 body + END.
  // Runtime image may lack node/python on PATH for Broker exec sessions.
  const dumped = await exec(
    token,
    lease.sandboxId,
    [
      `cd '${sandboxRoot}'`,
      `find . -type f -name '*.md' 2>/dev/null | while IFS= read -r rel; do`,
      `  rel=\${rel#./}`,
      `  [ -z "$rel" ] && continue`,
      `  echo "RECORD:$rel"`,
      `  base64 "$rel" | tr -d '\\n'`,
      `  echo`,
      `  echo END`,
      `done`,
    ].join('\n'),
  )
  if (dumped.exitCode !== 0) {
    throw new Error(`list/read failed: ${String(dumped.stderr || dumped.stdout || '').slice(0, 300)}`)
  }

  const files = {}
  const lines = String(dumped.stdout ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('RECORD:')) continue
    const rel = line.slice('RECORD:'.length)
    const b64 = lines[i + 1] ?? ''
    if (lines[i + 2] !== 'END') continue
    files[rel] = b64
    i += 2
  }

  const written = []
  let skipped = 0

  for (const [rel, b64] of Object.entries(files)) {
    const content = Buffer.from(b64, 'base64')
    const dest = join(outDir, rel.split('/').join(sep))
    mkdirSync(dirname(dest), { recursive: true })
    if (existsSync(dest)) {
      const prev = readFileSync(dest)
      if (Buffer.compare(prev, content) === 0) {
        skipped += 1
        continue
      }
    }
    writeFileSync(dest, content)
    written.push(rel)
  }

  return {
    sandboxId: lease.sandboxId,
    sessionId: lease.sessionId,
    written,
    skipped,
    total: Object.keys(files).length,
  }
}

async function main() {
  if (!watch) {
    const result = await pullOnce()
    console.log(`Pulled from sandbox ${result.sandboxId} (session ${result.sessionId})`)
    console.log(`Host dir: ${outDir}`)
    console.log(`Updated: ${result.written.length}  unchanged: ${result.skipped}  total: ${result.total ?? 0}`)
    for (const rel of result.written) console.log(`  + ${rel}`)
    if ((result.total ?? 0) === 0) console.log('No markdown files under sandbox workspace yet.')
    return
  }

  console.log(`Watching sandbox markdown → ${outDir} (every ${intervalMs}ms). Ctrl+C to stop.`)
  for (;;) {
    try {
      const result = await pullOnce()
      if (result.written.length) {
        const stamp = new Date().toISOString().slice(11, 19)
        console.log(`[${stamp}] synced ${result.written.length}: ${result.written.join(', ')}`)
      }
    } catch (error) {
      console.warn(`sync failed: ${error.message}`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

await main()
