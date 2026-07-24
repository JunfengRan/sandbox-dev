/**
 * Provider-agnostic OS isolation probe for scenario 3.
 * Usage:
 *   node scripts/test-scenario3-isolation.mjs <sandboxId> <linuxUserA> <linuxUserB> <dirA> [provider]
 * provider: daytona | e2b (default from SANDBOX_PROVIDER or e2b)
 */
import { Daytona } from '@daytona/sdk'

const sandboxId = process.argv[2]
const luA = process.argv[3]
const luB = process.argv[4]
const dirA = process.argv[5]
const providerArg = process.argv[6] ?? process.env.SANDBOX_PROVIDER ?? 'e2b'

if (!sandboxId || !luA || !luB || !dirA) {
  console.error('Usage: node test-scenario3-isolation.mjs <sandboxId> <linuxUserA> <linuxUserB> <dirA> [provider]')
  process.exit(1)
}

async function execDaytona(command) {
  const d = new Daytona({
    apiKey: process.env.DAYTONA_API_KEY,
    apiUrl: process.env.DAYTONA_API_URL,
    target: process.env.DAYTONA_TARGET,
  })
  const s = await d.get(sandboxId)
  const r = await s.process.executeCommand(command)
  return { exitCode: r.exitCode ?? 0, stdout: r.result ?? '', stderr: '' }
}

async function execE2b(command) {
  const base = (process.env.E2B_RUNTIME_URL ?? 'http://localhost:8090').replace(/\/$/, '')
  const res = await fetch(`${base}/v1/sandboxes/${encodeURIComponent(sandboxId)}/exec`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  })
  if (!res.ok) {
    throw new Error(`runtime exec failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  return { exitCode: data.exitCode ?? 0, stdout: data.stdout ?? '', stderr: data.stderr ?? '' }
}

const exec = providerArg === 'daytona' ? execDaytona : execE2b

const sudoProbe = await exec('sudo -u ocuser_001 id -u 2>/dev/null || echo fail')
const sudoOut = `${sudoProbe.stdout}\n${sudoProbe.stderr}`
const sudoWorks = sudoOut.split('\n').some((l) => l.trim() === '1001')
console.log('HAS_LINUX_USER:' + (sudoWorks ? 'yes' : 'no'))
console.log('PROVIDER:' + providerArg)

if (!sudoWorks) {
  console.log('ISOLATION_RESULT:SKIP:no_linux_users')
  process.exit(0)
}

const idA = await exec(`id -u ${luA} 2>/dev/null || echo missing`)
const idOut = `${idA.stdout}\n${idA.stderr}`
const uidLine = idOut.split('\n').find((l) => /^\d+$/.test(l.trim())) ?? idOut.trim()
console.log('USER_A_UID:' + uidLine)

if (uidLine === 'missing' || !/^\d+$/.test(uidLine.trim())) {
  console.log('ISOLATION_RESULT:SKIP:no_linux_users')
  process.exit(0)
}

await exec(
  `sudo -u ${luA} -- bash -lc 'mkdir -p ${dirA} && echo secret > ${dirA}/secret.txt && chmod 600 ${dirA}/secret.txt'`,
)
const r = await exec(`sudo -u ${luB} -- bash -lc 'cat ${dirA}/secret.txt 2>&1 || echo DENIED'`)
const combined = `${r.stdout}\n${r.stderr}`
const resultLine =
  combined
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('setlocale'))
    .pop() ?? combined.trim()
console.log('ISOLATION_RESULT:' + resultLine)

const passed =
  resultLine.includes('DENIED') ||
  resultLine.includes('Permission denied') ||
  resultLine.includes('No such file') ||
  resultLine.includes('cannot open')
console.log('ISOLATION_PASS:' + (passed ? 'yes' : 'no'))
process.exit(passed ? 0 : 1)
