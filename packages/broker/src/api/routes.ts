import express, { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import type { AcquireRequest, HeartbeatRequest, ReleaseRequest } from '@sandbox-dev/shared'
import { createApiError, toPublicErrorBody } from '@sandbox-dev/shared'
import type { BrokerService } from './broker-service.js'
import type { Config } from '../config.js'

interface AuthRequest extends Request {
  userId?: string
}

function authMiddleware(config: Config) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.path === '/health') return next()

    const header = req.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      const publicError = toPublicErrorBody(
        createApiError(401, 'AUTH.REQUIRED', 'Authentication required', false),
      )
      res.status(publicError.status).json(publicError.body)
      return
    }
    try {
      const payload = jwt.verify(header.slice(7), config.jwtSecret!) as { user_id?: string; userId?: string }
      req.userId = payload.user_id ?? payload.userId
      if (!req.userId) throw new Error('Token subject missing')
    } catch {
      const publicError = toPublicErrorBody(createApiError(401, 'AUTH.INVALID_TOKEN', 'Invalid token', false))
      res.status(publicError.status).json(publicError.body)
      return
    }

    next()
  }
}

export function createApp(config: Config, broker: BrokerService) {
  if (!config.jwtSecret) throw new Error('JWT_SECRET is required')
  const app = express()
  app.use(express.json())
  app.use(authMiddleware(config))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/v1/status', async (req: AuthRequest, res, next) => {
    try {
      res.json(await broker.status(req.userId!))
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/leases/acquire', async (req: AuthRequest, res, next) => {
    try {
      const body = req.body as AcquireRequest
      const result = await broker.acquire({ ...body, userId: req.userId! })
      res.status(result.status === 'queued' ? 202 : 200).json(result)
    } catch (err) {
      next(err)
    }
  })

  app.get('/v1/leases/poll', async (req: AuthRequest, res, next) => {
    try {
      const ticketId = req.query.ticketId as string
      if (!ticketId) {
        res.status(400).json({ error: 'ticketId required' })
        return
      }
      res.json(await broker.poll(req.userId!, ticketId))
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/leases/release', async (req: AuthRequest, res, next) => {
    try {
      const body = req.body as ReleaseRequest
      await broker.release({ ...body, userId: req.userId! })
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/leases/heartbeat', async (req: AuthRequest, res, next) => {
    try {
      const body = req.body as HeartbeatRequest
      const ok = await broker.heartbeat(req.userId!, body.sessionId)
      res.json({ ok })
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/sandboxes/:id/resize', async (req: AuthRequest, res, next) => {
    try {
      const body = req.body as { cpu?: number; memoryMiB?: number; diskGiB?: number }
      if (body.cpu == null || body.memoryMiB == null) {
        res.status(400).json({ error: 'cpu and memoryMiB required' })
        return
      }
      const result = await broker.resizeSandbox(req.userId!, req.params.id as string, {
        cpu: body.cpu,
        memoryMiB: body.memoryMiB,
        diskGiB: body.diskGiB,
      })
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/sandboxes/:id/exec', async (req: AuthRequest, res, next) => {
    try {
      const body = req.body as { command?: string; cwd?: string }
      if (!body.command) {
        res.status(400).json({ error: 'command required' })
        return
      }
      const result = await broker.execInSandbox(req.userId!, req.params.id as string, body.command, body.cwd)
      res.json(result)
    } catch (err) {
      next(err)
    }
  })

  app.use('/v1/workspaces/:sessionId/opencode', async (req: AuthRequest, res, next) => {
    const controller = new AbortController()
    req.on('aborted', () => controller.abort())
    try {
      const endpoint = await broker.getOpenCodeEndpoint(
        req.userId!,
        req.params.sessionId as string,
      )
      const headers = new Headers()
      Object.entries(req.headers).forEach(([key, value]) => {
        if (gatewayRequestHeaders.has(key.toLowerCase()) || value == null) return
        if (Array.isArray(value)) value.forEach((item) => headers.append(key, item))
        else headers.set(key, value)
      })
      headers.set('authorization', endpoint.authorization)
      if (endpoint.headers) {
        Object.entries(endpoint.headers).forEach(([key, value]) => headers.set(key, value))
      }
      const body =
        req.method === 'GET' || req.method === 'HEAD'
          ? undefined
          : req.body == null
            ? undefined
            : JSON.stringify(req.body)
      const target = new URL(`${endpoint.url.replace(/\/$/, '')}${req.url}`)
      // Node fetch forbids Host; Daytona preview routing needs it, so use http.request.
      if (headers.has('host')) {
        await proxyWithHostHeader(req, res, target, headers, body, controller.signal)
        return
      }
      const upstream = await fetch(target, {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
        redirect: 'manual',
      })
      res.status(upstream.status)
      // fetch auto-decompresses; drop stale compression metadata so clients parse JSON.
      upstream.headers.forEach((value, key) => {
        if (!gatewayResponseHeadersAfterFetch.has(key.toLowerCase())) res.setHeader(key, value)
      })
      if (!upstream.body) {
        res.end()
        return
      }
      const reader = upstream.body.getReader()
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        if (!res.write(Buffer.from(chunk.value))) await once(res, 'drain')
      }
      res.end()
    } catch (err) {
      if (!controller.signal.aborted) next(err)
    }
  })

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const publicError = toPublicErrorBody(err)
    if (publicError.status >= 500) console.error({ ref: publicError.body.ref, err })
    res.status(publicError.status).json(publicError.body)
  })

  return app
}

async function proxyWithHostHeader(
  req: Request,
  res: Response,
  target: URL,
  headers: Headers,
  body: string | undefined,
  signal: AbortSignal,
) {
  const host = headers.get('host')!
  headers.delete('host')
  await new Promise<void>((resolve, reject) => {
    const upstream = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...Object.fromEntries(headers.entries()), host },
        signal,
      },
      async (response) => {
        res.status(response.statusCode ?? 502)
        // Raw byte pipe: keep content-encoding / content-length so gzip bodies stay valid.
        for (const [key, value] of Object.entries(response.headers)) {
          if (value == null || hopByHopHeaders.has(key.toLowerCase())) continue
          res.setHeader(key, value)
        }
        response.on('data', async (chunk) => {
          if (!res.write(chunk)) await once(res, 'drain')
        })
        response.on('end', () => {
          res.end()
          resolve()
        })
        response.on('error', reject)
      },
    )
    upstream.on('error', reject)
    if (body) upstream.write(body)
    upstream.end()
  })
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
const gatewayRequestHeaders = new Set([
  ...hopByHopHeaders,
  'authorization',
  'host',
  'content-length',
  // undici rejects Expect; PowerShell and some clients send 100-continue
  'expect',
])
const gatewayResponseHeadersAfterFetch = new Set([...hopByHopHeaders, 'content-encoding', 'content-length'])

export function signUserToken(userId: string, secret: string): string {
  return jwt.sign({ user_id: userId }, secret, { expiresIn: '7d' as jwt.SignOptions['expiresIn'] })
}
