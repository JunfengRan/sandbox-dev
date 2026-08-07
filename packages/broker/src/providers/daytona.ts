import { Daytona, DaytonaNotFoundError, type Sandbox } from '@daytona/sdk'
import {
  asLinuxUser,
  wrapWithProcessLimits,
  type ExecOptions,
  type ExecResult,
  type SandboxInfo,
  type SandboxProvider,
  type SandboxResources,
  type SandboxService,
  type SandboxServiceEndpoint,
  type SandboxServiceSpec,
} from '@sandbox-dev/shared'
import { request as httpRequest } from 'node:http'
import type { Config } from '../config.js'

function mapState(state: string | undefined): SandboxInfo['state'] {
  if (state === 'started' || state === 'running') return 'started'
  if (state === 'stopped' || state === 'stopping') return 'stopped'
  return state ?? 'stopped'
}

function toDaytonaResources(resources: SandboxResources) {
  return {
    cpu: Math.max(1, Math.ceil(resources.cpu)),
    memory: Math.max(1, Math.ceil(resources.memoryMiB / 1024)),
    disk: Math.max(1, Math.ceil(resources.diskGiB ?? 3)),
  }
}

function fromDaytonaSandbox(sandbox: Sandbox): SandboxResources | undefined {
  const cpu = (sandbox as { cpu?: number }).cpu
  const memory = (sandbox as { memory?: number }).memory
  const disk = (sandbox as { disk?: number }).disk
  if (cpu == null && memory == null) return undefined
  return {
    cpu: cpu ?? 1,
    memoryMiB: (memory ?? 1) * 1024,
    diskGiB: disk,
  }
}

export class DaytonaSandboxProvider implements SandboxProvider {
  readonly name = 'daytona' as const
  private readonly daytona: Daytona
  private readonly services = new Map<string, { port: number }>()

  constructor(
    private readonly config: Config,
    daytona?: Daytona,
    private readonly request: typeof fetch = daytonaPreviewFetch,
  ) {
    this.daytona =
      daytona ??
      new Daytona({
        apiKey: config.daytonaApiKey,
        apiUrl: config.daytonaApiUrl,
        target: config.daytonaTarget,
      })
  }

  async create(labels?: Record<string, string>, resources?: SandboxResources): Promise<SandboxInfo> {
    const resolved = resources ?? this.config.defaultResources
    const params: Record<string, unknown> = { labels }
    // Daytona rejects resource overrides when a snapshot pins the envelope.
    if (this.config.snapshot) params.snapshot = this.config.snapshot
    else params.resources = toDaytonaResources(resolved)
    const sandbox = await this.daytona.create(params as Parameters<Daytona['create']>[0])
    await sandbox.start()
    return {
      id: sandbox.id,
      state: 'started',
      resources: fromDaytonaSandbox(sandbox) ?? resolved,
    }
  }

  async get(id: string): Promise<SandboxInfo> {
    const sandbox = await this.getRaw(id)
    return {
      id: sandbox.id,
      state: mapState(sandbox.state),
      resources: fromDaytonaSandbox(sandbox),
    }
  }

  async start(id: string): Promise<void> {
    const sandbox = await this.daytona.get(id)
    if (sandbox.state !== 'started') {
      await sandbox.start()
    }
  }

  async stop(id: string): Promise<void> {
    const sandbox = await this.daytona.get(id)
    if (sandbox.state === 'started') {
      await sandbox.stop()
    }
  }

  async delete(id: string): Promise<void> {
    const sandbox = await this.daytona.get(id)
    await sandbox.delete()
    for (const key of this.services.keys()) {
      if (key.startsWith(`${id}:`)) this.services.delete(key)
    }
  }

  async resize(id: string, resources: SandboxResources): Promise<SandboxInfo> {
    const sandbox = await this.getRaw(id)
    const target = toDaytonaResources(resources)
    const currentCpu = (sandbox as { cpu?: number }).cpu ?? 1
    const currentMem = (sandbox as { memory?: number }).memory ?? 1
    const needDecrease = target.cpu < currentCpu || target.memory < currentMem

    if (needDecrease && sandbox.state === 'started') {
      await sandbox.stop()
    }
    await sandbox.resize(target)
    if (sandbox.state !== 'started') {
      await sandbox.start()
    }
    const refreshed = await this.daytona.get(id)
    return {
      id: refreshed.id,
      state: mapState(refreshed.state),
      resources: fromDaytonaSandbox(refreshed) ?? resources,
    }
  }

  async exec(id: string, command: string, opts?: ExecOptions): Promise<ExecResult> {
    const sandbox = await this.getRaw(id)
    const limits = opts?.processLimits ?? this.config.defaultProcessLimits
    const wrapped = wrapWithProcessLimits(command, limits)
    const result = await sandbox.process.executeCommand(wrapped, opts?.cwd)
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.result ?? '',
      stderr: '',
    }
  }

  async ensureWorkDir(id: string, workDir: string): Promise<void> {
    await this.exec(id, `mkdir -p ${workDir}`)
  }

  async startService(id: string, spec: SandboxServiceSpec): Promise<SandboxService> {
    const sandbox = await this.getRaw(id)
    const sessionID = serviceSessionID(spec.name)
    try {
      await sandbox.process.getSession(sessionID)
    } catch (error) {
      if (!(error instanceof DaytonaNotFoundError)) throw error
      await sandbox.process.createSession(sessionID)
    }

    const environment = Object.entries(spec.env ?? {})
      .map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
          throw Object.assign(new Error(`Invalid env key: ${key}`), { status: 400 })
        }
        return `${key}=${shellEscape(value)}`
      })
      .join(' ')
    // Avoid bash -lc: Alpine OpenCode snapshots may not share login-shell PATH semantics.
    const command = [
      spec.cwd ? `cd ${shellEscape(spec.cwd)}` : undefined,
      environment ? `export ${environment}` : undefined,
      spec.command,
    ]
      .filter((part): part is string => part !== undefined)
      .join(' && ')

    await sandbox.process.executeSessionCommand(sessionID, { command, runAsync: true })
    this.services.set(serviceKey(id, spec.name), { port: spec.port })

    try {
      const endpoint = await this.endpoint(sandbox, spec.port)
      await waitForServiceReady(
        endpoint.url,
        spec.healthPath ?? '/',
        spec.readinessTimeoutMs ?? 30_000,
        this.request,
        { ...endpoint.headers, ...spec.healthHeaders },
      )
      return { name: spec.name, state: 'ready', endpoint }
    } catch (error) {
      this.services.delete(serviceKey(id, spec.name))
      await sandbox.process.deleteSession(sessionID).catch(() => undefined)
      throw error
    }
  }

  async getServiceEndpoint(id: string, name: string): Promise<SandboxServiceEndpoint> {
    const service = this.services.get(serviceKey(id, name))
    if (!service) throw Object.assign(new Error(`Service not found: ${name}`), { status: 404 })
    return this.endpoint(await this.getRaw(id), service.port)
  }

  async stopService(id: string, name: string): Promise<SandboxService> {
    const key = serviceKey(id, name)
    if (!this.services.has(key)) throw Object.assign(new Error(`Service not found: ${name}`), { status: 404 })
    const sandbox = await this.getRaw(id)
    await sandbox.process.deleteSession(serviceSessionID(name)).catch((error) => {
      if (!(error instanceof DaytonaNotFoundError)) throw error
    })
    this.services.delete(key)
    return { name, state: 'stopped' }
  }

  async setupMultiUserDirs(id: string, workDir: string): Promise<void> {
    const linuxUser = workDir.split('/')[2]
    await this.exec(id, asLinuxUser(linuxUser, `mkdir -p ${workDir}`))
  }

  async getRaw(id: string): Promise<Sandbox> {
    const sandbox = await this.daytona.get(id)
    if (sandbox.state !== 'started') {
      await sandbox.start()
    }
    return sandbox
  }

  private async endpoint(sandbox: Sandbox, port: number): Promise<SandboxServiceEndpoint> {
    const expiresInSeconds = 3600
    const preview = await sandbox.getSignedPreviewUrl(port, expiresInSeconds)
    // Node cannot resolve *.proxy.localhost; keep Host for Daytona routing and dial loopback.
    // In Docker Broker, 127.0.0.1:4000 is forwarded to the host proxy.
    return rewriteDaytonaPreviewEndpoint({
      url: preview.url,
      scope: 'provider-internal',
      expiresAt: Date.now() + expiresInSeconds * 1000,
    })
  }
}

function serviceKey(id: string, name: string) {
  return `${id}:${name}`
}

function serviceSessionID(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw Object.assign(new Error('Invalid service name'), { status: 400 })
  }
  return `service-${name}`
}

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function rewriteDaytonaPreviewEndpoint(endpoint: SandboxServiceEndpoint): SandboxServiceEndpoint {
  const url = new URL(endpoint.url)
  if (!url.hostname.endsWith('.proxy.localhost') && url.hostname !== 'proxy.localhost') {
    return endpoint
  }
  const host = url.host
  url.hostname = '127.0.0.1'
  return {
    ...endpoint,
    url: url.toString().replace(/\/$/, ''),
    headers: { ...endpoint.headers, host },
  }
}

/** fetch() forbids Host; Daytona preview routing requires it. */
export async function daytonaPreviewFetch(
  input: string | URL | Request,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
  const headers = new Headers(init.headers)
  const host = headers.get('host') ?? url.host
  if (url.hostname.endsWith('.proxy.localhost') || url.hostname === 'proxy.localhost') {
    url.hostname = '127.0.0.1'
  }
  headers.delete('host')

  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: init.method ?? 'GET',
        headers: { ...Object.fromEntries(headers.entries()), host },
        signal: init.signal ?? undefined,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        response.on('end', () => {
          resolve(
            new Response(Buffer.concat(chunks), {
              status: response.statusCode ?? 502,
              headers: response.headers as HeadersInit,
            }),
          )
        })
      },
    )
    request.on('error', reject)
    if (init.body) request.write(typeof init.body === 'string' ? init.body : Buffer.from(String(init.body)))
    request.end()
  })
}

async function waitForServiceReady(
  endpoint: string,
  healthPath: string,
  timeoutMs: number,
  request: typeof fetch,
  headers?: Record<string, string>,
) {
  const deadline = Date.now() + timeoutMs
  const rewritten = rewriteDaytonaPreviewEndpoint({ url: endpoint, scope: 'provider-internal', headers })
  const health = new URL(rewritten.url)
  health.pathname = `${health.pathname.replace(/\/$/, '')}${healthPath}`
  let lastError = ''

  while (Date.now() < deadline) {
    try {
      const signal = AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now())))
      const response = await request(health, { headers: rewritten.headers, signal })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, timeoutMs)))
  }
  throw new Error(`Service readiness timed out after ${timeoutMs}ms: ${lastError}`)
}
