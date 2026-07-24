import express, { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import type { AcquireRequest, HeartbeatRequest, ReleaseRequest } from '@sandbox-dev/shared'
import type { BrokerService } from './broker-service.js'
import type { Config } from '../config.js'

interface AuthRequest extends Request {
  userId?: string
}

function authMiddleware(config: Config) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.path === '/health') return next()

    const header = req.headers.authorization
    if (header?.startsWith('Bearer ') && config.jwtSecret) {
      try {
        const token = header.slice(7)
        const payload = jwt.verify(token, config.jwtSecret) as { user_id?: string; userId?: string }
        req.userId = payload.user_id ?? payload.userId
      } catch {
        res.status(401).json({ error: 'Invalid token' })
        return
      }
    }

    next()
  }
}

export function createApp(config: Config, broker: BrokerService) {
  const app = express()
  app.use(express.json())
  app.use(authMiddleware(config))

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' })
  })

  app.get('/v1/status', async (_req, res, next) => {
    try {
      res.json(await broker.status())
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/leases/acquire', async (req: AuthRequest, res, next) => {
    try {
      const body = req.body as AcquireRequest
      const userId = body.userId ?? req.userId!
      const result = await broker.acquire({ ...body, userId })
      res.status(result.status === 'queued' ? 202 : 200).json(result)
    } catch (err) {
      next(err)
    }
  })

  app.get('/v1/leases/poll', async (req, res, next) => {
    try {
      const ticketId = req.query.ticketId as string
      if (!ticketId) {
        res.status(400).json({ error: 'ticketId required' })
        return
      }
      res.json(await broker.poll(ticketId))
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/leases/release', async (req: AuthRequest, res, next) => {
    try {
      const body = req.body as ReleaseRequest
      await broker.release({ ...body, userId: body.userId ?? req.userId! })
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  app.post('/v1/leases/heartbeat', async (req: AuthRequest, res, next) => {
    try {
      const body = req.body as HeartbeatRequest
      const ok = await broker.heartbeat(body.userId ?? req.userId!, body.sessionId)
      res.json({ ok })
    } catch (err) {
      next(err)
    }
  })

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err)
    res.status(500).json({ error: err.message })
  })

  return app
}

export function signUserToken(userId: string, secret: string): string {
  return jwt.sign({ user_id: userId }, secret, { expiresIn: '7d' as jwt.SignOptions['expiresIn'] })
}
