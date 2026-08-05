#!/usr/bin/env node
/**
 * Minimal AIO Hands-compatible HTTP shim for local Broker tests.
 * Implements /v1/sandbox, /v1/shell/exec, /v1/file/read|write on :8080.
 * Replace with ghcr.io/agent-infra/sandbox via scripts/build-aio-image.ps1 when available.
 */
import { createServer } from 'node:http'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const execAsync = promisify(execCb)
const PORT = Number(process.env.PORT ?? 8080)
const WORKSPACE = process.env.WORKSPACE ?? '/home/gem/workspace'

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function send(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(data)
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    if (req.method === 'GET' && (url.pathname === '/v1/sandbox' || url.pathname === '/health')) {
      return send(res, 200, {
        success: true,
        data: { home_dir: '/home/gem', workspace: WORKSPACE, version: 'aio-shim-0.1.0' },
      })
    }

    if (req.method === 'POST' && url.pathname === '/v1/shell/exec') {
      const body = await readBody(req)
      const command = String(body.command ?? '')
      try {
        const { stdout, stderr } = await execAsync(command, {
          shell: '/bin/bash',
          cwd: WORKSPACE,
          env: { ...process.env, ...(body.env ?? {}) },
          maxBuffer: 10 * 1024 * 1024,
        })
        return send(res, 200, {
          success: true,
          data: { output: stdout ?? '', exit_code: 0, stderr: stderr ?? '' },
        })
      } catch (err) {
        const e = err
        return send(res, 200, {
          success: true,
          data: {
            output: `${e.stdout ?? ''}${e.stderr ?? e.message ?? ''}`,
            exit_code: typeof e.code === 'number' ? e.code : 1,
            stderr: e.stderr ?? '',
          },
        })
      }
    }

    if (req.method === 'POST' && url.pathname === '/v1/file/read') {
      const body = await readBody(req)
      const path = body.file ?? body.path
      if (!path) return send(res, 400, { success: false, message: 'file required' })
      const content = await readFile(path, 'utf8')
      return send(res, 200, { success: true, data: { content } })
    }

    if (req.method === 'POST' && url.pathname === '/v1/file/write') {
      const body = await readBody(req)
      const path = body.file ?? body.path
      if (!path || body.content === undefined) {
        return send(res, 400, { success: false, message: 'file and content required' })
      }
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, String(body.content), 'utf8')
      return send(res, 200, { success: true, data: { path } })
    }

    send(res, 404, { success: false, message: `not found: ${url.pathname}` })
  } catch (err) {
    send(res, 500, { success: false, message: err instanceof Error ? err.message : String(err) })
  }
})

await mkdir(WORKSPACE, { recursive: true })
server.listen(PORT, '0.0.0.0', () => {
  console.log(`aio-shim listening on :${PORT} workspace=${WORKSPACE}`)
})
