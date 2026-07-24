import { DockerSandboxManager } from './docker-manager.js'
import { createRuntimeApp } from './routes.js'

async function main() {
  const port = Number(process.env.PORT ?? 8090)
  const image = process.env.E2B_IMAGE ?? 'sandbox-dev/e2b-runtime:0.1.0'
  const cpu = Number(process.env.E2B_DEFAULT_CPU ?? 0.5)
  const memoryMiB = Number(process.env.E2B_DEFAULT_MEMORY_MIB ?? 512)
  const workDir = process.env.E2B_WORK_DIR ?? '/home/user/project'

  const manager = new DockerSandboxManager(image, cpu, memoryMiB, workDir)
  const app = createRuntimeApp(manager)

  app.listen(port, () => {
    console.log(`E2B-compatible sandbox-runtime listening on :${port}`)
    console.log(`image=${image} cpu=${cpu} memoryMiB=${memoryMiB} workDir=${workDir}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
