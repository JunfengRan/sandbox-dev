import { Daytona } from '@daytona/sdk'

const sandboxId = process.argv[2]
const luA = process.argv[3]
const luB = process.argv[4]
const dirA = process.argv[5]

if (!sandboxId || !luA || !luB || !dirA) {
  console.error('Usage: node test-scenario3-isolation.mjs <sandboxId> <linuxUserA> <linuxUserB> <dirA>')
  process.exit(1)
}

const d = new Daytona({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: process.env.DAYTONA_API_URL,
  target: process.env.DAYTONA_TARGET,
})

const s = await d.get(sandboxId)

const sudoProbe = await s.process.executeCommand('sudo -u ocuser_001 id -u 2>/dev/null || echo fail')
const sudoWorks = sudoProbe.result.split('\n').some((l) => l.trim() === '1001')
console.log('HAS_LINUX_USER:' + (sudoWorks ? 'yes' : 'no'))

if (!sudoWorks) {
  console.log('ISOLATION_RESULT:SKIP:no_linux_users')
  process.exit(0)
}

const idA = await s.process.executeCommand(`id -u ${luA} 2>/dev/null || echo missing`)
const uidLine = idA.result.split('\n').find((l) => /^\d+$/.test(l.trim())) ?? idA.result.trim()
console.log('USER_A_UID:' + uidLine)

if (uidLine === 'missing' || !/^\d+$/.test(uidLine.trim())) {
  console.log('ISOLATION_RESULT:SKIP:no_linux_users')
  process.exit(0)
}

await s.process.executeCommand(
  `sudo -u ${luA} -- bash -lc 'mkdir -p ${dirA} && echo secret > ${dirA}/secret.txt && chmod 600 ${dirA}/secret.txt'`,
)
const r = await s.process.executeCommand(
  `sudo -u ${luB} -- bash -lc 'cat ${dirA}/secret.txt 2>&1 || echo DENIED'`,
)
const resultLine =
  r.result
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.includes('setlocale'))
    .pop() ?? r.result.trim()
console.log('ISOLATION_RESULT:' + resultLine)

const passed =
  resultLine.includes('DENIED') ||
  resultLine.includes('Permission denied') ||
  resultLine.includes('No such file') ||
  resultLine.includes('cannot open')
console.log('ISOLATION_PASS:' + (passed ? 'yes' : 'no'))
process.exit(passed ? 0 : 1)
