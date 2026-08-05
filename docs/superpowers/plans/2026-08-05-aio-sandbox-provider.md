# AIO Sandbox Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 agent-infra AIO 沙箱作为 `SANDBOX_PROVIDER=aio` 接入 Broker，经扩展后的 sandbox-runtime 按租约创建 Docker 容器，用 AIO HTTP API 执行 shell/file，并跑通三场景部署测试。

**Architecture:** Broker 新增 `AioSandboxProvider`（HTTP 形态与 e2b 相同，打 runtime `/v1/sandboxes/*`）。sandbox-runtime 在 `RUNTIME_BACKEND=aio` 时用 docker 拉起 AIO 镜像、等待 `:8080` 就绪，exec/files 转发到容器内 `/v1/shell/exec` 与 `/v1/file/*`。场景 3 使用派生镜像 `sandbox-dev/aio-runtime:0.1.0`（AIO + `ocuser_*`）。

**Tech Stack:** TypeScript / Node 20、Express、dockerode、Docker Compose、PowerShell 场景脚本、镜像 `ghcr.io/agent-infra/sandbox:1.11.0`。

**Spec:** [docs/superpowers/specs/2026-08-05-aio-sandbox-provider-design.md](../specs/2026-08-05-aio-sandbox-provider-design.md)

## Global Constraints

- Hands 首版仅 shell + file；不接 Browser/MCP/Jupyter。
- 不破坏现有 `e2b` / `daytona` 默认路径（`RUNTIME_BACKEND` 默认 `e2b`）。
- AIO 容器保留官方 ENTRYPOINT，禁止改成 `sleep infinity`。
- 工作目录默认 `/home/gem/workspace`；默认规格建议 1 vCPU / 2048 MiB。
- 验收命令：`.\scripts\run-all-tests.ps1 -Provider aio`。
- 仓库无单元测试框架；验证以脚本 + `npm run build` 为准。
- Commit 时按用户规则处理 CI（华为 Codehub：先去掉 CI 再 git commit）。

---

## File Structure

| 文件 | 职责 |
|------|------|
| `packages/shared/src/index.ts` | `SandboxProviderName` 含 `aio`；`PROJECT_BASE_PATH.aio` |
| `packages/sandbox-runtime/src/aio-client.ts` | 调用 AIO HTTP、归一化 ExecResult |
| `packages/sandbox-runtime/src/docker-manager.ts` | aio create/ready；exec/files 分流 |
| `packages/sandbox-runtime/src/index.ts` | 读 `RUNTIME_BACKEND` / `AIO_*` |
| `packages/sandbox-runtime/src/routes.ts` | health 暴露 backend |
| `packages/broker/src/providers/aio.ts` | `AioSandboxProvider` |
| `packages/broker/src/providers/index.ts` | factory + parse |
| `packages/broker/src/config.ts` | aio 配置字段 |
| `packages/opencode-plugin/src/*` | provider / workDir |
| `snapshots/Dockerfile.aio-runtime` | 派生多用户镜像 |
| `scripts/build-aio-image.ps1` | 构建派生镜像 |
| `deploy/local/.env.example` + compose | aio 环境变量 |
| `scripts/run-all-tests.ps1` 等 | `-Provider aio` |
| `README.md` / `docs/TESTING.md` | 文档与结果 |

---

### Task 1: Shared types — `aio` provider name

**Files:**
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `SandboxProviderName` includes `'aio'`; `PROJECT_BASE_PATH.aio === '/home/gem/workspace'`

- [ ] **Step 1: Update types and base path**

In `packages/shared/src/index.ts`，将：

```ts
export type SandboxProviderName = 'daytona' | 'e2b'
```

改为：

```ts
export type SandboxProviderName = 'daytona' | 'e2b' | 'aio'
```

将：

```ts
export const PROJECT_BASE_PATH: Record<SandboxProviderName, string> = {
  daytona: '/home/daytona/project',
  e2b: '/home/user/project',
}
```

改为：

```ts
export const PROJECT_BASE_PATH: Record<SandboxProviderName, string> = {
  daytona: '/home/daytona/project',
  e2b: '/home/user/project',
  aio: '/home/gem/workspace',
}
```

- [ ] **Step 2: Build shared**

Run: `npm run build -w @sandbox-dev/shared`  
Expected: exit 0

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/index.ts
git commit -m "feat(shared): add aio sandbox provider name and workdir"
```

---

### Task 2: AIO HTTP client in sandbox-runtime

**Files:**
- Create: `packages/sandbox-runtime/src/aio-client.ts`

**Interfaces:**
- Produces:
  - `waitForAioReady(baseUrl: string, timeoutMs: number): Promise<void>`
  - `aioExec(baseUrl: string, command: string, opts?: { cwd?: string; apiKey?: string }): Promise<{ exitCode: number; stdout: string; stderr: string }>`
  - `aioReadFile(baseUrl: string, path: string, apiKey?: string): Promise<string>`
  - `aioWriteFile(baseUrl: string, path: string, content: string, apiKey?: string): Promise<void>`

- [ ] **Step 1: Implement `aio-client.ts`**

```ts
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
  const res = await fetch(url, {
    ...init,
    headers: { ...headers(apiKey), ...(init.headers as Record<string, string> | undefined) },
  })
  return res
}

export async function waitForAioReady(baseUrl: string, timeoutMs: number, apiKey?: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await aioFetch(`${baseUrl.replace(/\/$/, '')}/v1/sandbox`, { method: 'GET' }, apiKey)
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
  const stderr = String(data.stderr ?? data.message ?? '')
  return { exitCode, stdout, stderr: exitCode !== 0 && !stderr ? stdout : stderr }
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
```

若本地对照 OpenAPI 发现字段名不同，只改本文件。

- [ ] **Step 2: Commit**

```bash
git add packages/sandbox-runtime/src/aio-client.ts
git commit -m "feat(sandbox-runtime): add AIO HTTP client adapter"
```

---

### Task 3: DockerSandboxManager AIO backend

**Files:**
- Modify: `packages/sandbox-runtime/src/docker-manager.ts`
- Modify: `packages/sandbox-runtime/src/index.ts`
- Modify: `packages/sandbox-runtime/src/routes.ts`

**Interfaces:**
- Consumes: `waitForAioReady`, `aioExec`, `aioReadFile`, `aioWriteFile`
- Produces: records with `backend: 'e2b' | 'aio'` and optional `endpoint: string`

- [ ] **Step 1: Extend `SandboxRecord` and constructor options**

在 `docker-manager.ts`：

```ts
export type RuntimeBackend = 'e2b' | 'aio'

export interface SandboxRecord {
  id: string
  containerId: string
  state: SandboxState
  image: string
  workDir: string
  labels: Record<string, string>
  createdAt: number
  resources?: { cpu: number; memoryMiB: number }
  backend: RuntimeBackend
  endpoint?: string
}
```

Constructor 增加：

```ts
constructor(
  private readonly defaultImage: string,
  private readonly defaultCpu: number,
  private readonly defaultMemoryMiB: number,
  private readonly defaultWorkDir: string,
  private readonly backend: RuntimeBackend = 'e2b',
  private readonly aioApiKey?: string,
  private readonly aioReadyTimeoutMs: number = 120_000,
  private readonly dockerNetwork: string = 'sandbox-dev-aio',
) { ... }
```

- [ ] **Step 2: AIO `create` path**

当 `this.backend === 'aio'`：

1. `ensureNetwork(this.dockerNetwork)`（不存在则 `createNetwork`）。
2. `createContainer`：
   - `Image`: opts.image ?? defaultImage
   - **不要**设置 `Cmd: ['sleep','infinity']`；不覆盖 Entrypoint
   - `Labels` 含 `sandbox-dev.backend=aio`
   - `HostConfig`: NanoCpus, Memory, `SecurityOpt: ['seccomp=unconfined']`, `ShmSize: 2 * 1024 * 1024 * 1024`, `NetworkMode: this.dockerNetwork`
3. `start` → inspect `NetworkSettings.Networks[network].IPAddress`
4. `endpoint = http://${ip}:8080`
5. `await waitForAioReady(endpoint, this.aioReadyTimeoutMs, this.aioApiKey)`；失败则 remove 容器并 throw
6. 写入 meta 含 `backend: 'aio', endpoint`

e2b 路径保持原逻辑，record.backend = `'e2b'`。

- [ ] **Step 3: Branch `exec` / `readFile` / `writeFile`**

```ts
async exec(id: string, opts: ExecOptions): Promise<ExecResult> {
  const record = await this.get(id)
  if (record.state !== 'started') await this.start(id)
  if (record.backend === 'aio') {
    if (!record.endpoint) throw new Error(`AIO sandbox ${id} missing endpoint`)
    return aioExec(record.endpoint, opts.command, {
      cwd: opts.cwd ?? record.workDir,
      apiKey: this.aioApiKey,
    })
  }
  // existing docker exec...
}
```

`readFile` / `writeFile`：aio 走 `aioReadFile` / `aioWriteFile`；e2b 保持。

`start` 后若 aio：重新 inspect IP，更新 `endpoint`，再 `waitForAioReady`（短超时可接受）。

- [ ] **Step 4: Wire `index.ts`**

```ts
const backend = (process.env.RUNTIME_BACKEND === 'aio' ? 'aio' : 'e2b') as 'aio' | 'e2b'
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
  process.env.AIO_API_KEY,
  Number(process.env.AIO_READY_TIMEOUT_MS ?? 120_000),
  process.env.AIO_DOCKER_NETWORK ?? 'sandbox-dev-aio',
)
```

health（`routes.ts`）增加 `backend` 字段。

- [ ] **Step 5: Build runtime**

Run: `npm run build -w @sandbox-dev/sandbox-runtime`  
Expected: exit 0

- [ ] **Step 6: Commit**

```bash
git add packages/sandbox-runtime/src/docker-manager.ts packages/sandbox-runtime/src/index.ts packages/sandbox-runtime/src/routes.ts packages/sandbox-runtime/src/aio-client.ts
git commit -m "feat(sandbox-runtime): AIO docker backend with HTTP exec"
```

---

### Task 4: Broker `AioSandboxProvider`

**Files:**
- Create: `packages/broker/src/providers/aio.ts`
- Modify: `packages/broker/src/providers/index.ts`
- Modify: `packages/broker/src/config.ts`

**Interfaces:**
- Consumes: shared `SandboxProvider`；config `e2bRuntimeUrl`（复用）+ aio image/workdir
- Produces: `AioSandboxProvider` with `name = 'aio'`

- [ ] **Step 1: Add config fields**

在 `Config` 增加：

```ts
aioImage: string
aioWorkDir: string
aioRuntimeUrl: string  // 默认同 e2bRuntimeUrl
```

`loadConfig`：

```ts
aioRuntimeUrl: process.env.AIO_RUNTIME_URL ?? process.env.E2B_RUNTIME_URL ?? 'http://localhost:8090',
aioImage: process.env.AIO_IMAGE ?? 'sandbox-dev/aio-runtime:0.1.0',
aioWorkDir: process.env.AIO_WORK_DIR ?? PROJECT_BASE_PATH.aio,
```

`parseSandboxProvider`：

```ts
export function parseSandboxProvider(value: string | undefined): SandboxProviderName {
  if (value === 'e2b') return 'e2b'
  if (value === 'aio') return 'aio'
  return 'daytona'
}
```

- [ ] **Step 2: Implement `aio.ts`**

以 `packages/broker/src/providers/e2b.ts` 为模板复制为 `aio.ts`：

- `readonly name = 'aio' as const`
- `baseUrl` → `config.aioRuntimeUrl`
- create body：`image: this.config.aioImage`，`workDir: this.config.aioWorkDir`
- 错误前缀改为 `AIO runtime`

- [ ] **Step 3: Factory**

```ts
case 'aio':
  return new AioSandboxProvider(config)
case 'e2b':
  return new E2BSandboxProvider(config)
case 'daytona':
default:
  return new DaytonaSandboxProvider(config)
```

- [ ] **Step 4: Build broker**

Run: `npm run build -w @sandbox-dev/broker`  
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add packages/broker/src/providers/aio.ts packages/broker/src/providers/index.ts packages/broker/src/config.ts
git commit -m "feat(broker): add AioSandboxProvider"
```

---

### Task 5: OpenCode plugin + aio image

**Files:**
- Modify: `packages/opencode-plugin/src/index.ts`
- Modify: `packages/opencode-plugin/src/broker-session-manager.ts`
- Create: `snapshots/Dockerfile.aio-runtime`
- Create: `scripts/build-aio-image.ps1`

**Interfaces:**
- Produces: plugin resolves `aio` workDir；image build script tags `sandbox-dev/aio-runtime:0.1.0`

- [ ] **Step 1: Plugin provider / workDir**

`index.ts` REPO_PATH：

```ts
const REPO_PATH =
  process.env.SANDBOX_PROVIDER === 'aio' || process.env.AIO_WORK_DIR
    ? (process.env.AIO_WORK_DIR ?? '/home/gem/workspace')
    : process.env.SANDBOX_PROVIDER === 'e2b' || process.env.E2B_RUNTIME_URL
      ? (process.env.E2B_WORK_DIR ?? '/home/user/project')
      : '/home/daytona/project'
```

`broker-session-manager.ts` `resolvePreferredProvider`：

```ts
function resolvePreferredProvider(): SandboxProviderName {
  const p = process.env.SANDBOX_PROVIDER
  if (p === 'e2b' || p === 'aio' || p === 'daytona') return p
  return 'daytona'
}
```

确认 handle 创建逻辑：aio 与 e2b 一样用 `E2BSandboxHandle`（或别名），runtime URL = `AIO_RUNTIME_URL ?? E2B_RUNTIME_URL`。

- [ ] **Step 2: Dockerfile.aio-runtime**

```dockerfile
# Build: docker build -t sandbox-dev/aio-runtime:0.1.0 -f snapshots/Dockerfile.aio-runtime snapshots/
ARG BASE_IMAGE=ghcr.io/agent-infra/sandbox:1.11.0
FROM ${BASE_IMAGE}

USER root

RUN set -eux; \
    for i in $(seq 1 32); do \
      id=$(printf '%03d' $i); \
      if ! id "ocuser_${id}" >/dev/null 2>&1; then \
        useradd -m -s /bin/bash "ocuser_${id}"; \
      fi; \
      mkdir -p "/home/ocuser_${id}/project/sessions"; \
      chown -R "ocuser_${id}:ocuser_${id}" "/home/ocuser_${id}"; \
    done; \
    if id gem >/dev/null 2>&1; then PRIMARY=gem; \
    elif id user >/dev/null 2>&1; then PRIMARY=user; \
    else PRIMARY=root; fi; \
    for i in $(seq 1 32); do \
      id=$(printf '%03d' $i); \
      echo "${PRIMARY} ALL=(ocuser_${id}) NOPASSWD: ALL"; \
    done > /etc/sudoers.d/aio-ocusers; \
    chmod 440 /etc/sudoers.d/aio-ocusers; \
    echo "${PRIMARY} ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/aio-primary-all; \
    chmod 440 /etc/sudoers.d/aio-primary-all

# Keep base image ENTRYPOINT/CMD (AIO supervisor). Do not override with sleep infinity.
```

若国内拉不动 GHCR，文档注明：

`docker build --build-arg BASE_IMAGE=enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.11.0 ...`

- [ ] **Step 3: `scripts/build-aio-image.ps1`**

```powershell
param(
  [string]$Tag = 'sandbox-dev/aio-runtime:0.1.0',
  [string]$BaseImage = $(if ($env:AIO_BASE_IMAGE) { $env:AIO_BASE_IMAGE } else { 'ghcr.io/agent-infra/sandbox:1.11.0' })
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
docker build --build-arg "BASE_IMAGE=$BaseImage" -t $Tag -f "$root\snapshots\Dockerfile.aio-runtime" "$root\snapshots"
Write-Host "Built $Tag from $BaseImage"
```

- [ ] **Step 4: Build plugin**

Run: `npm run build -w @sandbox-dev/opencode-plugin`  
Expected: exit 0

- [ ] **Step 5: Commit**

```bash
git add packages/opencode-plugin/src/index.ts packages/opencode-plugin/src/broker-session-manager.ts snapshots/Dockerfile.aio-runtime scripts/build-aio-image.ps1
git commit -m "feat: aio plugin paths and multi-user AIO image"
```

---

### Task 6: Deploy compose + test scripts + docs

**Files:**
- Modify: `deploy/local/docker-compose.yml`, `deploy/local/.env.example`
- Modify: `deploy/server/docker-compose.yml`, `deploy/server/.env.example`（若存在同类变量则对齐）
- Modify: `scripts/run-all-tests.ps1`, `scripts/test-scenario1-queue.ps1`, `scripts/test-scenario3-multi-user.ps1`, `scripts/test-scenario3-isolation.mjs`
- Modify: `config/opencode-client.env.example`
- Modify: `README.md`, `docs/TESTING.md`

- [ ] **Step 1: Compose / env**

`sandbox-runtime` environment 增加：

```yaml
RUNTIME_BACKEND: ${RUNTIME_BACKEND:-e2b}
AIO_IMAGE: ${AIO_IMAGE:-sandbox-dev/aio-runtime:0.1.0}
AIO_WORK_DIR: ${AIO_WORK_DIR:-/home/gem/workspace}
AIO_API_KEY: ${AIO_API_KEY:-}
AIO_READY_TIMEOUT_MS: ${AIO_READY_TIMEOUT_MS:-120000}
AIO_DOCKER_NETWORK: ${AIO_DOCKER_NETWORK:-sandbox-dev-aio}
```

`broker` environment 增加：

```yaml
AIO_RUNTIME_URL: ${AIO_RUNTIME_URL:-http://sandbox-runtime:8090}
AIO_IMAGE: ${AIO_IMAGE:-sandbox-dev/aio-runtime:0.1.0}
AIO_WORK_DIR: ${AIO_WORK_DIR:-/home/gem/workspace}
```

`.env.example` 增加 aio 段落与注释：使用 aio 时设 `SANDBOX_PROVIDER=aio`、`RUNTIME_BACKEND=aio`，建议 `SANDBOX_CPU=1`、`SANDBOX_MEMORY_MIB=2048`。

- [ ] **Step 2: Test scripts accept `aio`**

`ValidateSet('e2b', 'daytona', 'aio')`。

`ExecInSandbox`：`if ($Provider -eq 'e2b' -or $Provider -eq 'aio')` 走 runtime HTTP。

`test-scenario3-isolation.mjs`：provider 允许 `aio`。

- [ ] **Step 3: README / TESTING**

README Provider 表增加 `aio` 行与快速开始小节（build-aio-image → compose → run-all-tests）。  
TESTING 增加 aio 前置条件与结果表（先留空行，Task 7 填实测）。

- [ ] **Step 4: Commit**

```bash
git add deploy scripts config README.md docs/TESTING.md
git commit -m "docs(deploy): wire aio provider into compose and tests"
```

---

### Task 7: Deploy and run scenario tests

**Files:**
- Modify: `docs/TESTING.md`（填实测结果）

- [ ] **Step 1: Build image**

```powershell
cd E:\sandbox-dev
.\scripts\build-aio-image.ps1
```

Expected: `Built sandbox-dev/aio-runtime:0.1.0 ...`  
若 GHCR 失败，设 `$env:AIO_BASE_IMAGE` 为国内 mirror 重试。

- [ ] **Step 2: Start stack**

```powershell
cd E:\sandbox-dev\deploy\local
# .env: SANDBOX_PROVIDER=aio, RUNTIME_BACKEND=aio, SANDBOX_CPU=1, SANDBOX_MEMORY_MIB=2048
docker compose up -d --build
Invoke-RestMethod http://localhost:8080/health
Invoke-RestMethod http://localhost:8090/health
```

Expected: broker ok；runtime `backend=aio`（若已暴露）。

- [ ] **Step 3: Run scenarios**

```powershell
cd E:\sandbox-dev
docker exec local-redis-1 redis-cli FLUSHALL
.\scripts\run-all-tests.ps1 -Provider aio
```

Expected: 场景 1/2/3 均为 PASS（含场景 3 linuxUser `ocuser_*`）。  
若场景 3 FAIL：根据 sudo/用户排查 Dockerfile，修后重跑，勿降级验收标准除非镜像无法支持（则文档标明原因）。

- [ ] **Step 4: Record results + final commit**

更新 `docs/TESTING.md` aio 结果表；`git commit`；按用户要求 `git push`。

---

## Spec coverage checklist

| Spec 要求 | Task |
|-----------|------|
| `SANDBOX_PROVIDER=aio` | 1, 4 |
| 按租约 docker 多实例 | 3 |
| AIO HTTP shell/file | 2, 3 |
| 不接 Browser/MCP | Global / 未做即合规 |
| 场景 3 派生镜像 | 5 |
| compose + run-all-tests | 6, 7 |
| e2b 默认不变 | 3 index 默认 `RUNTIME_BACKEND=e2b` |

## Plan self-review

- 无 TBD/TODO 占位。  
- 类型名 `SandboxProviderName` / `AioSandboxProvider` / `RUNTIME_BACKEND` 前后一致。  
- 插件复用 E2B handle 已写明，避免重复 runtime API。
