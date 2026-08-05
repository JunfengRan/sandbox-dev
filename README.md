# Sandbox Broker — Hands / 控制面（Daytona + 自托管 E2B-compatible + AIO）

本仓库在 **Agent Harness（Brain）** 与 **隔离执行环境（Hands）** 之间提供 **Sandbox Broker** 控制面，目标对齐：

- [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) 的 **self-hosted sandbox / Hands** 分层（本仓库不托管模型循环）
- [OpenAI Agents SDK SandboxClient](https://developers.openai.com/api/docs/guides/agents/sandboxes) 的 **session → sandbox + lifecycle** 抽象

**本仓库职责（Hands）**：租约、并发槽位、排队、sandbox 生命周期、工具执行隔离。  
**不在本仓库**：Messages/Responses agent loop、Session Events SSE、完整 Anthropic/OpenAI 托管 harness。

## Provider

| `SANDBOX_PROVIDER` | 隔离 | 部署 | 说明 |
|--------------------|------|------|------|
| `daytona`（保留） | Docker 容器（Daytona） | 需本地/远端 Daytona API | 原有路径，功能完整 |
| `e2b`（默认 local） | Docker 容器（E2B-compatible API） | `sandbox-runtime` + docker.sock | **自托管**，不依赖 E2B Cloud；**不是** Firecracker microVM |
| `aio` | Docker 容器（[agent-infra AIO](https://github.com/agent-infra/sandbox)） | `sandbox-runtime`（`RUNTIME_BACKEND=aio`）+ docker.sock | 按租约起 AIO 镜像；Hands 用 `/v1/shell` + `/v1/file`；首版不接 Browser/MCP |

> 真 Firecracker / 官方 `e2b-dev/infra` 需要 Linux + KVM，无法在 Windows Docker Desktop 上作为本仓库默认路径。本实现用 **E2B 风格 HTTP API**（create/exec/files/stop/kill）+ 更小默认规格（0.5 vCPU / 512 MiB）做轻量对照。

## 架构

```
OpenCode / 上游 Agent (Brain)
    │  @sandbox-dev/opencode-plugin
    ▼
Sandbox Broker (:8080) ── Redis + Kafka
    │  SandboxProvider
    ├─ daytona → Daytona API (:3000) → Runner → Linux Sandbox
    ├─ e2b     → sandbox-runtime (:8090) → Docker Engine → Linux Sandbox
    └─ aio     → sandbox-runtime (:8090, RUNTIME_BACKEND=aio) → AIO 容器 (:8080 HTTP)
```

场景能力（三种 provider 均支持）：

1. **场景 1**：服务器沙箱并发上限 + Redis 槽位 + Kafka 排队，`session.idle` 释放槽位  
2. **场景 2**：同一用户多个 OpenCode session 共享一个 sandbox（目录隔离）  
3. **场景 3（实验）**：多个用户共享 pool sandbox（Linux 子用户 / sudo 隔离）

> Windows 客户端无需 WSL：Agent 在本地，工具在远端 Linux 沙箱执行。

## 快速开始（E2B-compatible，推荐本地）

### 1. 构建 sandbox 镜像

```powershell
cd E:\sandbox-dev
.\scripts\build-e2b-image.ps1
```

### 2. 启动 Broker 栈（含 sandbox-runtime）

```powershell
cd E:\sandbox-dev\deploy\local
copy .env.example .env
# SANDBOX_PROVIDER=e2b（默认）
docker compose up -d --build
Invoke-RestMethod http://localhost:8080/health
Invoke-RestMethod http://localhost:8090/health
```

### 3. 跑三场景

```powershell
cd E:\sandbox-dev
docker exec local-redis-1 redis-cli FLUSHALL
.\scripts\run-all-tests.ps1 -Provider e2b
.\scripts\measure-e2b-resources.ps1
```

完整结果与 CPU/内存估算见 **[docs/TESTING.md](docs/TESTING.md)**。

## 快速开始（AIO / agent-infra）

```powershell
cd E:\sandbox-dev
.\scripts\build-aio-image.ps1
# 若 GHCR 拉不动，可设国内 mirror：
# $env:AIO_BASE_IMAGE='enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.11.0'
# .\scripts\build-aio-image.ps1

cd deploy\local
# .env: SANDBOX_PROVIDER=aio, RUNTIME_BACKEND=aio, SANDBOX_CPU=1, SANDBOX_MEMORY_MIB=2048
docker compose up -d --build
cd ..\..
docker exec local-redis-1 redis-cli FLUSHALL
.\scripts\run-all-tests.ps1 -Provider aio
```

设计与实现计划见 `docs/superpowers/specs/2026-08-05-aio-sandbox-provider-design.md`。

## 快速开始（Daytona，保留）

参考 [docs/local-daytona-setup.md](docs/local-daytona-setup.md)：

```powershell
# Daytona 已启动后
cd E:\sandbox-dev\deploy\local
# .env 中设置 SANDBOX_PROVIDER=daytona 与 DAYTONA_API_KEY
docker compose up -d --build
.\scripts\run-all-tests.ps1 -Provider daytona
```

### 构建插件 / 配置 OpenCode

```powershell
cd E:\sandbox-dev
npm install
npm run build
```

`~/.config/opencode/opencode.json`：

```json
{
  "plugin": [
    "opencode-dotenv",
    "@sandbox-dev/opencode-plugin"
  ]
}
```

环境变量（参考 [config/opencode-client.env.example](config/opencode-client.env.example)）：

```env
DAYTONA_BROKER_URL=http://localhost:8080
SANDBOX_PROVIDER=e2b
E2B_RUNTIME_URL=http://localhost:8090
OPENCODE_USER_ID=alice
DAYTONA_BROKER_MODE=exclusive
# 仅 daytona provider 需要：
# DAYTONA_API_URL=http://localhost:3000/api
# DAYTONA_API_KEY=...
```

## 实测摘要

### Daytona（2026-07-24）

| 场景 | API | OS/目录隔离 |
|------|-----|-------------|
| 1 并发排队 | **PASS** | — |
| 2 同用户多 session | **PASS** | **PASS** |
| 3 跨用户拼车 | **PASS** | **PASS**（multi-user snapshot） |

### E2B-compatible（自托管 Docker，2026-07-24 实测）

| 场景 | API | OS/目录隔离 |
|------|-----|-------------|
| 1 并发排队 | **PASS** | — |
| 2 同用户多 session | **PASS** | **PASS** |
| 3 跨用户拼车 | **PASS** | **PASS** |

空闲 sandbox RSS ≈ **2 MiB**（`sleep infinity`）；规划仍按 **0.5 vCPU / 512 MiB** limit。控制面实测 ≈ **0.3–0.35 GiB**（Redis+Redpanda+Broker+runtime）。

### AIO / agent-infra（2026-08-05 实测）

| 场景 | API | OS/目录隔离 |
|------|-----|-------------|
| 1 并发排队 | **PASS** | — |
| 2 同用户多 session | **PASS** | **PASS** |
| 3 跨用户拼车 | **PASS** | **PASS** |

基于完整 AIO 镜像（`all-in-one-sandbox:1.11.0` + 多用户派生层）；默认 **1 vCPU / 2048 MiB**；Hands 路径经 HTTP `/v1/shell` + `/v1/file`。

### 资源估算对照（默认规格）

| Provider | 默认每 sandbox | exclusive 每用户 | multi_user 4 人拼车（建议） |
|----------|----------------|------------------|-----------------------------|
| Daytona | 1 vCPU / 1 GiB | 1 vCPU / 1 GiB | ~0.5 vCPU / ~512 MiB（2vCPU/2GiB 容器） |
| E2B-compatible | 0.5 vCPU / 512 MiB | 0.5 vCPU / 512 MiB | ~0.25 vCPU / ~256 MiB（同容器均分） |
| AIO | 1 vCPU / 2 GiB | 1 vCPU / 2 GiB | ~0.5 vCPU / ~1 GiB（建议，镜像较重） |

Broker 控制面（Redis + Redpanda + Node + runtime）：约 **0.3–0.35 GiB**（负载峰值可达 ~0.4 GiB）。

平均态 / 极限态（E2B 已测；Daytona 因 Runner 502 待补）见 **[docs/LOAD-CAPACITY.md](docs/LOAD-CAPACITY.md)**。  
沙箱弹性规格 + 进程上限见 **[docs/ELASTIC-SCALING.md](docs/ELASTIC-SCALING.md)**。

## Broker API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/v1/status` | 活跃租约、队列、`provider` |
| POST | `/v1/leases/acquire` | `{ userId, sessionId, mode?, poolId? }` → 含 `provider` |
| GET | `/v1/leases/poll?ticketId=` | 排队轮询 |
| POST | `/v1/leases/release` | `{ userId, sessionId, reason?: idle\|deleted }` |
| POST | `/v1/leases/heartbeat` | 续租（超时由 `LEASE_TTL_MS` 回收） |

### sandbox-runtime API（E2B-compatible）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/sandboxes` | create |
| GET | `/v1/sandboxes/:id` | info |
| POST | `/v1/sandboxes/:id/start\|stop` | start / stop≈pause |
| DELETE | `/v1/sandboxes/:id` | kill |
| POST | `/v1/sandboxes/:id/exec` | commands.run |
| POST | `/v1/sandboxes/:id/files/read\|write` | files |

### 模式

| `DAYTONA_BROKER_MODE` / acquire `mode` | 行为 |
|---------------------------------------|------|
| `exclusive` | 每 session 独立 sandbox（生产默认） |
| `user_shared` | 同 user_id 共享 sandbox，session 目录隔离 |
| `multi_user_shared` | 同 pool 共享 sandbox，Linux 子用户隔离（实验） |

## 项目结构

```
packages/shared/           # 共享类型 + SandboxProvider 接口
packages/broker/           # Broker（leases + provider 注入）
packages/sandbox-runtime/  # 自托管 E2B-compatible Docker 运行时
packages/opencode-plugin/  # OpenCode 插件（SandboxHandle）
deploy/local/              # 本地 Compose（redis/redpanda/runtime/broker）
deploy/server/             # 服务器 Compose
snapshots/                 # e2b-runtime / multi-user 镜像
scripts/                   # 场景测试与资源采样
docs/                      # setup, testing, Windows capability boundaries
```

## 已知限制

- E2B provider 为 **容器级**隔离，不能替代 microVM 多租户安全边界
- 场景 3 `ocuser_*` 仅 32 槽，存在 hash 碰撞风险；生产默认 `exclusive`
- `IdlePolicy: pool` 未实现（文档保留；运行时按 `stop_keep`/`delete`）
- 真 Firecracker 自托管不在本仓库范围
- **Windows 操作边界**：沙箱为 Linux 容器，无 pywin32/COM/注册表/Windows GUI；宿主浏览器不能直连沙箱端口（需转发，本仓未封装）——详见 **[docs/WINDOWS-CAPABILITY-BOUNDARIES.md](docs/WINDOWS-CAPABILITY-BOUNDARIES.md)**

与 Claude Managed Agents 的对齐结论、以及后续演进项见 **[docs/FUTURE-WORK.md](docs/FUTURE-WORK.md)**。

## 参考

- [docs/FUTURE-WORK.md](docs/FUTURE-WORK.md) — CMA 对齐结论与未来工作
- [docs/WINDOWS-CAPABILITY-BOUNDARIES.md](docs/WINDOWS-CAPABILITY-BOUNDARIES.md) — Windows 操作 / 端口 / GUI 能力边界
- [docs/TESTING.md](docs/TESTING.md) — 测试方法、Daytona / E2B-compatible 实测与资源估算
- [docs/LOAD-CAPACITY.md](docs/LOAD-CAPACITY.md) — 平均态 / 极限态 CPU·内存实测
- [docs/ELASTIC-SCALING.md](docs/ELASTIC-SCALING.md) — 沙箱弹性规格与进程资源上限
- [docs/local-daytona-setup.md](docs/local-daytona-setup.md) — Daytona 本地联调
- [Claude Managed Agents — Self-hosted](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- [OpenAI Sandbox Agents](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [Daytona OpenCode 插件](https://www.daytona.io/docs/en/guides/opencode/opencode-plugin/)
