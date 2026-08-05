import express, { type Request, type Response, type NextFunction } from 'express'
import { DockerSandboxManager } from './docker-manager.js'

export function createRuntimeApp(manager: DockerSandboxManager) {
  const app = express()
  app.use(express.json({ limit: '10mb' }))

  app.get('/health', (_req, res) => {
    const backend = manager.getBackend()
    res.json({
      status: 'ok',
      runtime: backend === 'aio' ? 'aio' : 'e2b-compatible',
      backend,
    })
  })

  app.post('/v1/sandboxes', async (req, res, next) => {
    try {
      const body = req.body as {
        image?: string
        template?: string
        labels?: Record<string, string>
        cpu?: number
        memoryMiB?: number
        workDir?: string
      }
      const sandbox = await manager.create({
        image: body.image ?? body.template,
        labels: body.labels,
        cpu: body.cpu,
        memoryMiB: body.memoryMiB,
        workDir: body.workDir,
      })
      res.status(201).json({
        sandboxId: sandbox.id,
        id: sandbox.id,
        state: sandbox.state,
        workDir: sandbox.workDir,
        image: sandbox.image,
        resources: sandbox.resources,
      })
    } catch (err) {
      next(err)
    }
  })

  app.get('/v1/sandboxes/:id', async (req, res, next) => {
    try {
      const sandbox = await manager.get(req.params.id)
      res.json({
        sandboxId: sandbox.id,
        id: sandbox.id,
        state: sandbox.state,
        workDir: sandbox.workDir,
        image: sandbox.image,
        resources: sandbox.resources,
      })
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/sandboxes/:id/start', async (req, res, next) => {
    try {
      const sandbox = await manager.start(req.params.id)
      res.json({ id: sandbox.id, state: sandbox.state, resources: sandbox.resources })
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/sandboxes/:id/stop', async (req, res, next) => {
    try {
      const sandbox = await manager.stop(req.params.id)
      res.json({ id: sandbox.id, state: sandbox.state })
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/sandboxes/:id/resize', async (req, res, next) => {
    try {
      const body = req.body as { cpu?: number; memoryMiB?: number }
      if (body.cpu == null || body.memoryMiB == null) {
        res.status(400).json({ error: 'cpu and memoryMiB required' })
        return
      }
      const sandbox = await manager.resize(req.params.id, body.cpu, body.memoryMiB)
      res.json({
        id: sandbox.id,
        state: sandbox.state,
        resources: sandbox.resources ?? { cpu: body.cpu, memoryMiB: body.memoryMiB },
      })
    } catch (err) {
      next(err)
    }
  })

  app.delete('/v1/sandboxes/:id', async (req, res, next) => {
    try {
      await manager.kill(req.params.id)
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/sandboxes/:id/exec', async (req, res, next) => {
    try {
      const body = req.body as { command: string; cwd?: string; env?: Record<string, string> }
      if (!body.command) {
        res.status(400).json({ error: 'command required' })
        return
      }
      const result = await manager.exec(req.params.id, body)
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/sandboxes/:id/files/read', async (req, res, next) => {
    try {
      const path = (req.body as { path?: string }).path
      if (!path) {
        res.status(400).json({ error: 'path required' })
        return
      }
      const content = await manager.readFile(req.params.id, path)
      res.json({ path, content })
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/sandboxes/:id/files/write', async (req, res, next) => {
    try {
      const body = req.body as { path?: string; content?: string }
      if (!body.path || body.content === undefined) {
        res.status(400).json({ error: 'path and content required' })
        return
      }
      await manager.writeFile(req.params.id, body.path, body.content)
      res.json({ ok: true, path: body.path })
    } catch (err) {
      next(err)
    }
  })

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500
    console.error(err)
    res.status(status).json({ error: err.message })
  })

  return app
}
