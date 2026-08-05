import { DockerSandboxManager, type RuntimeBackend } from './docker-manager.js'
import { createRuntimeApp } from './routes.js'

async function main() {
  const port = Number(process.env.PORT ?? 8090)
  const backend: RuntimeBackend = process.env.RUNTIME_BACKEND === 'aio' ? 'aio' : 'e2b'
  const image =
    process.env.AIO_IMAGE ??
    process.env.E2B_IMAGE ??
    (backend === 'aio' ? 'sandbox-dev/aio-runtime:0.1.0' : 'sandbox-dev/e2b-runtime:0.1.0')
  const workDir =
    process.env.AIO_WORK_DIR ??
    process.env.E2B_WORK_DIR ??
    (backend === 'aio' ? '/home/gem/workspace' : '/home/user/project')
  const cpu = Number(process.env.E2B_DEFAULT_CPU ?? (backend === 'aio' ? 1 : 0.5))
  const memoryMiB = Number(process.env.E2B_DEFAULT_MEMORY_MIB ?? (backend === 'aio' ? 2048 : 512))

  const manager = new DockerSandboxManager(
    image,
    cpu,
    memoryMiB,
    workDir,
    backend,
    process.env.AIO_API_KEY || undefined,
    Number(process.env.AIO_READY_TIMEOUT_MS ?? 120_000),
    process.env.AIO_DOCKER_NETWORK ?? 'sandbox-dev-aio',
  )
  const app = createRuntimeApp(manager)

  app.listen(port, () => {
    console.log(`sandbox-runtime listening on :${port} backend=${backend}`)
    console.log(`image=${image} cpu=${cpu} memoryMiB=${memoryMiB} workDir=${workDir}`)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
