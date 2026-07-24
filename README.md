# Daytona OpenCode 多用户沙箱 Broker

在 Daytona 与 OpenCode 之间增加 **Sandbox Broker** 层，实现：

1. **场景 1**：服务器沙箱并发上限 + Redis 槽位 + Kafka 排队，`session.idle` 释放槽位
2. **场景 2**：同一用户多个 OpenCode session 共享一个 sandbox（目录 + Process Session 隔离）
3. **场景 3（实验）**：多个用户共享 pool sandbox（Linux 子用户 / bubblewrap 隔离）

> Windows 客户端无需 WSL：Agent 在本地，工具在远端 Linux 沙箱执行（与 `@daytona/opencode` 相同模型）。

## 架构

```
OpenCode (Windows/macOS/Linux)
    │  @sandbox-dev/opencode-plugin
    ▼
Sandbox Broker (:8080) ── Redis + Kafka
    ▼
Daytona API (:3000) → Runner → Linux Sandbox
```

## 快速开始（本地调试）

### 1. 启动 Daytona

参考 [docs/local-daytona-setup.md](docs/local-daytona-setup.md)：

```powershell
cd E:\daytona
docker compose -f docker/docker-compose.yaml up -d
Invoke-RestMethod http://localhost:3000/api/health
```

### 2. 启动 Broker 栈

```powershell
cd E:\sandbox-dev\deploy\local
copy .env.example .env
# 编辑 .env，填入 DAYTONA_API_KEY
docker compose up -d --build
Invoke-RestMethod http://localhost:8080/health
```

### 3. 构建插件

```powershell
cd E:\sandbox-dev
npm install
npm run build
```

### 4. 配置 OpenCode

在 `~/.config/opencode/opencode.json` 中：

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
DAYTONA_API_URL=http://localhost:3000/api
DAYTONA_API_KEY=<你的本地 Key>
DAYTONA_TARGET=us
DAYTONA_BROKER_URL=http://localhost:8080
OPENCODE_USER_ID=alice
DAYTONA_BROKER_MODE=exclusive
```

本地开发可将插件链接到 workspace：

```powershell
cd E:\sandbox-dev\packages\opencode-plugin
npm link
cd E:\your-project
npm link @sandbox-dev/opencode-plugin
```

或在 `opencode.json` 中使用绝对路径指向 `E:/sandbox-dev/packages/opencode-plugin/dist/index.js`（需先 `npm run build`）。

### 5. 验证

```powershell
cd E:\opencode-test
git init
opencode run "run pwd only"
# 期望: /home/daytona/project
```

Broker 日志：`Get-Content "$env:LOCALAPPDATA\opencode\log\daytona-broker.log" -Tail 30`

## 场景测试与资源规划

完整测试方法、实测结果与 CPU/内存估算见 **[docs/TESTING.md](docs/TESTING.md)**。

### 快速测试

```powershell
# 需先启动 Daytona + Broker
docker exec local-redis-1 redis-cli FLUSHALL
.\scripts\test-scenario1-queue.ps1
.\scripts\test-scenario2-multi-session.ps1
.\scripts\test-scenario3-multi-user.ps1
# 或一次性：.\scripts\run-all-tests.ps1
```

### 实测摘要（2026-07-24，本地 Daytona v0.190）

| 场景 | API | OS/目录隔离 | 说明 |
|------|-----|-------------|------|
| 1 并发排队 | **PASS** | — | 2 granted + 1 queued，idle 后 dequeue |
| 2 同用户多 session | **PASS** | **PASS** | 同 sandbox，不同 workDir |
| 3 跨用户拼车 | **PASS** | **PASS** | 需 `sandbox-dev-multi-user:0.1.1` |

### 资源估算（默认 snapshot：1 vCPU / 1 GiB / sandbox）

| 模式 | 每容器用户数 | 建议容器规格 | 每用户约（4 人拼车） |
|------|-------------|-------------|---------------------|
| `exclusive` | 1 | 1 vCPU, 1 GiB | 1 vCPU, 1 GiB |
| `user_shared` | 1 用户，N session | 1 vCPU, 1 GiB | 1/N（按活跃 session） |
| `multi_user_shared` | 2–4 舒适† | 2 vCPU, 2 GiB | ~0.5 vCPU, ~512 MiB |

† 理论最多 32 个 `ocuser_*` 槽位；并发再高建议拆 pool 或改 `exclusive`。Broker 控制面（Redis + Redpanda + Node）另需约 **0.7–1 GiB**。

## 场景测试脚本

| 脚本 | 说明 |
|------|------|
| [scripts/test-scenario1-queue.ps1](scripts/test-scenario1-queue.ps1) | 3 用户 acquire，第 3 个排队，idle 释放后 dequeue |
| [scripts/test-scenario2-multi-session.ps1](scripts/test-scenario2-multi-session.ps1) | 同用户两 session 共享 sandbox、不同 workDir |
| [scripts/test-scenario3-multi-user.ps1](scripts/test-scenario3-multi-user.ps1) | 跨用户 pool 共享 + API + OS 文件隔离 |
| [scripts/register-multi-user-snapshot.ps1](scripts/register-multi-user-snapshot.ps1) | 构建并推送 multi-user snapshot |

```powershell
# 需先启动 Daytona + Broker（见 docs/TESTING.md）
.\scripts\run-all-tests.ps1
```

## Broker API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查 |
| GET | `/v1/status` | 活跃租约、队列长度 |
| POST | `/v1/leases/acquire` | `{ userId, sessionId, mode?, poolId? }` |
| GET | `/v1/leases/poll?ticketId=` | 排队轮询 |
| POST | `/v1/leases/release` | `{ userId, sessionId, reason?: idle\|deleted }` |
| POST | `/v1/leases/heartbeat` | 续租 |

### 模式

| `DAYTONA_BROKER_MODE` | 行为 |
|-----------------------|------|
| `exclusive` | 每 session 独立 sandbox（生产默认） |
| `user_shared` | 同 user_id 共享 sandbox，session 级目录隔离 |
| `multi_user_shared` | 同 pool 共享 sandbox，Linux 子用户隔离（实验） |

## 服务器部署

```powershell
cd deploy/server
copy .env.example .env
# 配置 DAYTONA_API_URL、DAYTONA_API_KEY、JWT_SECRET
docker compose up -d --build
```

客户端使用 JWT：

```powershell
# 在 broker 容器或本地生成 token（需 JWT_SECRET）
node -e "const j=require('jsonwebtoken');console.log(j.sign({user_id:'alice'},process.env.JWT_SECRET,{expiresIn:'7d'}))"
```

```env
DAYTONA_BROKER_URL=https://broker.example.com
DAYTONA_BROKER_TOKEN=<jwt>
```

## 场景 3：Multi-user Snapshot（拼车 / 跨用户共享）

对标业界 [Vercel Sandbox Multi-Agent](https://vercel.com/docs/sandbox/multi-agent) 模式：同容器内预置 `ocuser_001..032` Linux 账户，通过 **passwordless sudo** 切换 UID，实现文件权限级隔离。

### 构建与注册

```powershell
# 1. 确保已有 0.1.0 基础镜像（含 ocuser_*）；0.1.1 在其上追加 sudoers
docker build --platform linux/amd64 -t sandbox-dev/multi-user:0.1.1 -f snapshots/Dockerfile.multi-user snapshots/

# 或一键脚本（build + push 到 localhost:6000）
.\scripts\register-multi-user-snapshot.ps1 -Tag 0.1.1
```

在 Daytona Dashboard → Snapshots 注册 `registry:6000/daytona/sandbox-dev-multi-user:0.1.1`，名称设为 `sandbox-dev-multi-user` 并激活。

Broker `.env` 中设置：

```env
DAYTONA_SNAPSHOT=sandbox-dev-multi-user
```

### 验证（本地 Daytona v0.190 实测）

| 检查项 | 结果 |
|--------|------|
| user-a / user-b 同 sandboxId | **PASS** |
| 不同 `ocuser_XXX` 映射 | **PASS**（如 `ocuser_032` vs `ocuser_001`） |
| user-b 读 user-a secret 文件 | **PASS**（`Permission denied` / `DENIED`） |
| OpenCode 命令经 sudo 包装 | **PASS** |

```powershell
.\scripts\test-scenario3-multi-user.ps1
# 期望: API layer PASS, OS isolation PASS
```

### 安全边界

**能实现**：

- Broker 调度层「拼车」：多个 user_id 共享同一 sandbox，降低容器数量
- Linux UID + 文件权限隔离（需 custom snapshot `sandbox-dev-multi-user`）
- 备选降级：`bubblewrap` bind mount（弱于真实 UID 隔离）

**不能替代**：

- microVM / 独立容器级多租户安全边界（如 E2B、AWS AgentCore）
- 不可信多租户生产环境

**限制**：

- `ocuser_*` 仅 32 个槽位，存在 hash 碰撞风险
- 共享内核，CVE 风险仍在
- Docker 镜像会 strip setuid，`runuser` 不可用；本项目改用 **sudo + sudoers** 实现用户切换

**生产建议**：默认 `exclusive` + 并发限制；场景 3 仅适合受控实验或内部 semi-trusted 场景。

## 与官方 @daytona/opencode 的差异

| 项目 | 官方插件 | 本 Broker 插件 |
|------|----------|----------------|
| Sandbox 创建 | 直连 Daytona API | 经 Broker acquire（支持排队） |
| session.idle | Git sync，不释放 | 释放并发槽位 + stop sandbox |
| session.deleted | 删除 sandbox | 同上 + Broker release |
| 多 session 共享 | 不支持 | user_shared 模式 |
| Git sync | 默认开启 | exclusive 可保留；共享模式禁用 |

## 项目结构

```
packages/shared/          # 共享类型
packages/broker/          # Broker 服务
packages/opencode-plugin/ # OpenCode 插件
deploy/local/             # 本地 Docker Compose
deploy/server/            # 服务器 Docker Compose
docs/                     #  setup, testing, resource planning
scripts/                  # PowerShell 验证脚本
snapshots/                # 场景 3 自定义镜像
```

## 已知限制

- 场景 1/2 已验证 **PASS**；场景 3 在 `sandbox-dev-multi-user` snapshot 下 API + OS 隔离 **PASS**（实验性）
- 场景 3 跨用户共享 sandbox **不推荐生产**；优先使用 `exclusive` + 并发限制
- `multi_user_shared` 需要含 `ocuser_*` + sudoers 的自定义 snapshot（见 `snapshots/Dockerfile.multi-user`）
- Broker 模式下 Git 自动同步在共享模式中默认禁用

## 参考

- [docs/local-daytona-setup.md](docs/local-daytona-setup.md) — 本地 Daytona + OpenCode + Broker 启动与调试
- [docs/TESTING.md](docs/TESTING.md) — 测试方法、实测结果、资源估算
- [Daytona OpenCode 插件文档](https://www.daytona.io/docs/en/guides/opencode/opencode-plugin/)
