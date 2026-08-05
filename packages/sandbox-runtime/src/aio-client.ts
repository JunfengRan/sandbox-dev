export interface AioExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) h['X-AIO-API-Key'] = apiKey
  return h
}

async function aioFetch(url: string, init: RequestInit, apiKey?: string): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...headers(apiKey), ...(init.headers as Record<string, string> | undefined) },
  })
}

export async function waitForAioReady(baseUrl: string, timeoutMs: number, apiKey?: string): Promise<void> {
  const root = baseUrl.replace(/\/$/, '')
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await aioFetch(`${root}/v1/sandbox`, { method: 'GET' }, apiKey)
      if (res.ok) return
      last = await res.text()
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(`AIO sandbox not ready within ${timeoutMs}ms: ${last}`)
}

export async function aioExec(
  baseUrl: string,
  command: string,
  opts?: { cwd?: string; apiKey?: string },
): Promise<AioExecResult> {
  const cmd = opts?.cwd ? `cd ${shellQuote(opts.cwd)} && ${command}` : command
  const res = await aioFetch(
    `${baseUrl.replace(/\/$/, '')}/v1/shell/exec`,
    { method: 'POST', body: JSON.stringify({ command: cmd }) },
    opts?.apiKey,
  )
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`AIO exec invalid JSON (${res.status}): ${text.slice(0, 500)}`)
  }
  if (!res.ok) {
    throw new Error(`AIO exec failed (${res.status}): ${text.slice(0, 500)}`)
  }
  return normalizeExec(body)
}

function normalizeExec(body: unknown): AioExecResult {
  const b = body as Record<string, unknown>
  const data = (b.data ?? b) as Record<string, unknown>
  const exitCode = Number(data.exit_code ?? data.exitCode ?? b.exit_code ?? 0)
  const stdout = String(data.output ?? data.stdout ?? '')
  const stderr = String(data.stderr ?? '')
  return { exitCode, stdout, stderr }
}

export async function aioReadFile(baseUrl: string, path: string, apiKey?: string): Promise<string> {
  const res = await aioFetch(
    `${baseUrl.replace(/\/$/, '')}/v1/file/read`,
    { method: 'POST', body: JSON.stringify({ file: path, path }) },
    apiKey,
  )
  const text = await res.text()
  if (!res.ok) throw new Error(`AIO file read failed (${res.status}): ${text.slice(0, 500)}`)
  const body = JSON.parse(text) as Record<string, unknown>
  const data = (body.data ?? body) as Record<string, unknown>
  return String(data.content ?? data.text ?? '')
}

export async function aioWriteFile(
  baseUrl: string,
  path: string,
  content: string,
  apiKey?: string,
): Promise<void> {
  const res = await aioFetch(
    `${baseUrl.replace(/\/$/, '')}/v1/file/write`,
    { method: 'POST', body: JSON.stringify({ file: path, path, content }) },
    apiKey,
  )
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`AIO file write failed (${res.status}): ${text.slice(0, 500)}`)
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
