import { PassThrough } from 'node:stream'
import Docker from 'dockerode'
import { v4 as uuidv4 } from 'uuid'

export type SandboxState = 'creating' | 'started' | 'stopped' | 'archived'

export interface CreateSandboxOptions {
  image?: string
  labels?: Record<string, string>
  cpu?: number
  memoryMiB?: number
  workDir?: string
}

export interface ExecOptions {
  command: string
  cwd?: string
  env?: Record<string, string>
}

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface SandboxRecord {
  id: string
  containerId: string
  state: SandboxState
  image: string
  workDir: string
  labels: Record<string, string>
  createdAt: number
  resources?: { cpu: number; memoryMiB: number }
}

function mapDockerState(status?: string): SandboxState {
  if (!status) return 'archived'
  if (status === 'running') return 'started'
  if (status === 'created' || status === 'exited' || status === 'paused') return 'stopped'
  return 'archived'
}

export class DockerSandboxManager {
  private readonly docker: Docker
  private readonly meta = new Map<string, SandboxRecord>()

  constructor(
    private readonly defaultImage: string,
    private readonly defaultCpu: number,
    private readonly defaultMemoryMiB: number,
    private readonly defaultWorkDir: string,
  ) {
    this.docker = new Docker({ socketPath: process.env.DOCKER_SOCKET ?? '/var/run/docker.sock' })
  }

  async create(opts: CreateSandboxOptions = {}): Promise<SandboxRecord> {
    const id = `sbx_${uuidv4().replace(/-/g, '').slice(0, 16)}`
    const image = opts.image ?? this.defaultImage
    const workDir = opts.workDir ?? this.defaultWorkDir
    const cpu = opts.cpu ?? this.defaultCpu
    const memoryMiB = opts.memoryMiB ?? this.defaultMemoryMiB
    const labels = {
      'sandbox-dev.managed': 'true',
      'sandbox-dev.sandbox-id': id,
      ...(opts.labels ?? {}),
    }

    await this.ensureImage(image)

    const container = await this.docker.createContainer({
      Image: image,
      name: `sandbox-dev-${id}`,
      WorkingDir: workDir,
      Labels: labels,
      Cmd: ['sleep', 'infinity'],
      HostConfig: {
        NanoCpus: Math.round(cpu * 1e9),
        Memory: memoryMiB * 1024 * 1024,
        AutoRemove: false,
      },
      Tty: false,
      OpenStdin: false,
    })

    await container.start()
    const record: SandboxRecord = {
      id,
      containerId: container.id,
      state: 'started',
      image,
      workDir,
      labels,
      createdAt: Date.now(),
      resources: { cpu, memoryMiB },
    }
    this.meta.set(id, record)
    return record
  }

  async get(id: string): Promise<SandboxRecord> {
    const record = await this.resolve(id)
    const container = this.docker.getContainer(record.containerId)
    const info = await container.inspect()
    record.state = mapDockerState(info.State?.Status)
    this.meta.set(id, record)
    return record
  }

  async start(id: string): Promise<SandboxRecord> {
    const record = await this.resolve(id)
    const container = this.docker.getContainer(record.containerId)
    const info = await container.inspect()
    if (!info.State?.Running) {
      await container.start()
    }
    record.state = 'started'
    this.meta.set(id, record)
    return record
  }

  async stop(id: string): Promise<SandboxRecord> {
    const record = await this.resolve(id)
    const container = this.docker.getContainer(record.containerId)
    const info = await container.inspect()
    if (info.State?.Running) {
      await container.stop({ t: 5 })
    }
    record.state = 'stopped'
    this.meta.set(id, record)
    return record
  }

  async resize(id: string, cpu: number, memoryMiB: number): Promise<SandboxRecord> {
    const record = await this.get(id)
    const container = this.docker.getContainer(record.containerId)
    await container.update({
      NanoCpus: Math.round(cpu * 1e9),
      Memory: memoryMiB * 1024 * 1024,
      MemorySwap: memoryMiB * 1024 * 1024,
    })
    record.resources = { cpu, memoryMiB }
    this.meta.set(id, record)
    return this.get(id)
  }

  async kill(id: string): Promise<void> {
    const record = await this.resolve(id)
    const container = this.docker.getContainer(record.containerId)
    try {
      const info = await container.inspect()
      if (info.State?.Running) {
        await container.stop({ t: 2 })
      }
      await container.remove({ force: true })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('No such container') && !msg.includes('404')) throw err
    }
    this.meta.delete(id)
  }

  async exec(id: string, opts: ExecOptions): Promise<ExecResult> {
    const record = await this.get(id)
    if (record.state !== 'started') {
      await this.start(id)
    }
    const container = this.docker.getContainer(record.containerId)
    const cwd = opts.cwd ?? record.workDir
    const cmd = ['bash', '-lc', `cd ${shellEscape(cwd)} && ${opts.command}`]

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
    })

    const stream = await exec.start({ hijack: true, stdin: false })
    const { stdout, stderr } = await demuxDockerStream(this.docker, stream)
    const inspect = await exec.inspect()
    return {
      exitCode: inspect.ExitCode ?? 0,
      stdout,
      stderr,
    }
  }

  async readFile(id: string, path: string): Promise<string> {
    const result = await this.exec(id, {
      command: `cat ${shellEscape(path)}`,
    })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to read ${path}`)
    }
    return result.stdout
  }

  async writeFile(id: string, path: string, content: string): Promise<void> {
    const b64 = Buffer.from(content, 'utf-8').toString('base64')
    const result = await this.exec(id, {
      command: `mkdir -p "$(dirname ${shellEscape(path)})" && echo ${shellEscape(b64)} | base64 -d > ${shellEscape(path)}`,
    })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `Failed to write ${path}`)
    }
  }

  private async ensureImage(image: string): Promise<void> {
    try {
      await this.docker.getImage(image).inspect()
    } catch {
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err)
          this.docker.modem.followProgress(stream, (followErr: Error | null) => {
            if (followErr) reject(followErr)
            else resolve()
          })
        })
      })
    }
  }

  private async resolve(id: string): Promise<SandboxRecord> {
    const cached = this.meta.get(id)
    if (cached) return cached

    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`sandbox-dev.sandbox-id=${id}`] },
    })
    if (containers.length === 0) {
      throw Object.assign(new Error(`Sandbox not found: ${id}`), { status: 404 })
    }
    const c = containers[0]
    const record: SandboxRecord = {
      id,
      containerId: c.Id,
      state: mapDockerState(c.State),
      image: c.Image,
      workDir: this.defaultWorkDir,
      labels: c.Labels ?? {},
      createdAt: (c.Created ?? 0) * 1000,
    }
    this.meta.set(id, record)
    return record
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function demuxDockerStream(
  docker: Docker,
  stream: NodeJS.ReadableStream,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const stdoutStream = new PassThrough()
    const stderrStream = new PassThrough()
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    stdoutStream.on('data', (c: Buffer) => stdoutChunks.push(c))
    stderrStream.on('data', (c: Buffer) => stderrChunks.push(c))

    docker.modem.demuxStream(stream, stdoutStream, stderrStream)

    stream.on('end', () => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
        stderr: Buffer.concat(stderrChunks).toString('utf-8'),
      })
    })
    stream.on('error', reject)
  })
}
