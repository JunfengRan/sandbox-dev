import express, { type Request, type Response, type NextFunction } from 'express'
import { once } from 'node:events'
import {
  createApiError,
  toPublicErrorBody,
  type SandboxService,
  type SandboxServiceEndpoint,
  type SandboxServiceSpec,
} from '@sandbox-dev/shared'
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

  app.post('/v1/sandboxes/:id/services', async (req, res, next) => {
    try {
      const spec = parseServiceSpec(req.body)
      const service = await manager.startService(req.params.id, spec)
      res.status(201).json(withProxyEndpoint(req, req.params.id, service))
    } catch (err) {
      next(err)
    }
  })

  app.get('/v1/sandboxes/:id/services/:name/endpoint', async (req, res, next) => {
    try {
      await manager.getServiceEndpoint(req.params.id, req.params.name)
      res.json(proxyEndpoint(req, req.params.id, req.params.name))
    } catch (err) {
      next(err)
    }
  })

  app.use('/v1/sandboxes/:id/services/:name/proxy', async (req, res, next) => {
    const abort = new AbortController()
    req.once('aborted', () => abort.abort())
    try {
      const endpoint = await manager.getServiceEndpoint(req.params.id, req.params.name)
      const target = new URL(req.url, `${endpoint.url.replace(/\/$/, '')}/`)
      const headers = new Headers()
      Object.entries(req.headers).forEach(([key, value]) => {
        if (value === undefined || hopByHopHeaders.has(key.toLowerCase())) return
        headers.set(key, Array.isArray(value) ? value.join(', ') : value)
      })
      headers.delete('host')
      const body =
        req.method === 'GET' || req.method === 'HEAD' || req.body === undefined
          ? undefined
          : Buffer.isBuffer(req.body)
            ? req.body.toString()
            : typeof req.body === 'string'
              ? req.body
              : JSON.stringify(req.body)
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        signal: abort.signal,
      })
      res.status(upstream.status)
      upstream.headers.forEach((value, key) => {
        if (!responseHeadersRemovedAfterFetch.has(key.toLowerCase())) res.setHeader(key, value)
      })
      if (!upstream.body) {
        res.end()
        return
      }
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await once(res, 'drain')
      }
      res.end()
    } catch (err) {
      if (!abort.signal.aborted) next(err)
    }
  })

  app.delete('/v1/sandboxes/:id/services/:name', async (req, res, next) => {
    try {
      res.json(await manager.stopService(req.params.id, req.params.name))
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

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const publicError = toPublicErrorBody(normalizeRuntimeError(err))
    if (publicError.status >= 500) console.error({ ref: publicError.body.ref, err })
    res.status(publicError.status).json(publicError.body)
  })

  return app
}

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])
const responseHeadersRemovedAfterFetch = new Set([...hopByHopHeaders, 'content-encoding', 'content-length'])

function withProxyEndpoint(request: Request, sandboxID: string, service: SandboxService): SandboxService {
  if (!service.endpoint) return service
  return { ...service, endpoint: proxyEndpoint(request, sandboxID, service.name) }
}

function proxyEndpoint(request: Request, sandboxID: string, name: string): SandboxServiceEndpoint {
  return {
    url: `${request.protocol}://${request.get('host')}/v1/sandboxes/${encodeURIComponent(sandboxID)}/services/${encodeURIComponent(name)}/proxy`,
    scope: 'provider-internal',
  }
}

function parseServiceSpec(value: unknown): SandboxServiceSpec {
  const body = value as Partial<SandboxServiceSpec>
  if (!body.name || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(body.name)) {
    throw badRequest('service name must contain only letters, numbers, "_" or "-"')
  }
  if (!body.command?.trim()) throw badRequest('command required')
  if (!Number.isInteger(body.port) || (body.port ?? 0) < 1 || (body.port ?? 0) > 65535) {
    throw badRequest('port must be an integer between 1 and 65535')
  }
  if (body.healthPath && !body.healthPath.startsWith('/')) {
    throw badRequest('healthPath must start with "/"')
  }
  if (
    body.readinessTimeoutMs !== undefined &&
    (!Number.isFinite(body.readinessTimeoutMs) || body.readinessTimeoutMs <= 0)
  ) {
    throw badRequest('readinessTimeoutMs must be positive')
  }
  return body as SandboxServiceSpec
}

function badRequest(message: string) {
  return createApiError(400, 'RUNTIME.BAD_REQUEST', message, false)
}

function normalizeRuntimeError(err: Error) {
  if ('code' in err && typeof err.code === 'string' && 'status' in err && typeof err.status === 'number') {
    return err
  }
  const status =
    'status' in err && typeof err.status === 'number' ? err.status : 500
  if (status === 400) return createApiError(400, 'RUNTIME.BAD_REQUEST', err.message, false, err)
  if (status === 404) return createApiError(404, 'RUNTIME.NOT_FOUND', err.message, false, err)
  return createApiError(status, 'RUNTIME.UNKNOWN', err.message, status >= 500, err)
}
