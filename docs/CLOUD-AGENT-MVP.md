# 云端 Agent MVP — 已完成能力沉淀

> 日期：2026-08-07  
> 分支：`cloud-agent-runtime`  
> 两仓：`sandbox-dev`（控制面）+ OpenCode fork（运行时适配，见文末）

本文汇总当前已打通的云端 Agent demo 能力、明确能力边界，以及后续优化项。更细的专题文档见文末索引。

---

## 1. 目标与架构

**目标**：本地 Web Client 经网关连接「沙箱内 `opencode serve`」，Agent 在云端沙箱执行；控制面负责租约、鉴权与反代，不把 IAM/调度塞进 OpenCode 主仓。

```
浏览器 packages/app :5173
        │  URL: /server/{base64(http://localhost:4096)}/session/{id}
        ▼
demo-web-gateway :4096     （CORS + JWT + 模型目录补齐）
        │  Bearer JWT
        ▼
Broker :8080
        │  /v1/workspaces/:sessionId/opencode/*
        ▼
Daytona preview → sandbox 内 opencode serve :4096
        │
        └── /home/user/project  （Agent 读写）
                 │
                 └── demo-pull-md.mjs → 主机 E:\sandbox-dev\demo-output\
```

| 仓库 | 职责 |
| --- | --- |
| `sandbox-dev` | Broker、SandboxProvider、JWT 网关、服务生命周期、demo 脚本与镜像 |
| OpenCode fork | 公共错误契约、SSE `id` 等可上游化的最小运行时改动（**当前 Daytona 镜像仍多为上游二进制**） |

---

## 2. 已完成功能

### 2.1 控制面与沙箱

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Provider 抽象 | 已完成 | Daytona / E2B-compatible / AIO；统一 `startService` / `getServiceEndpoint` / `stopService` + readiness |
| 云端 Agent 主路径 | 已完成（Daytona demo） | exclusive workspace → 沙箱内 `opencode serve`，非本地 Hands plugin 主路径 |
| JWT 强制鉴权 | 已完成 | Broker 保护路由；主体来自 token，不信任 body `userId` |
| Workspace 租约 | 已完成 | acquire / poll / heartbeat / release；并发槽位与排队 |
| 租户隔离 | 已完成（MVP） | 跨租户 `exec` / 代理拒绝；OpenCode Basic 内部口令不暴露给浏览器 |
| OpenCode 反代 | 已完成 | `/v1/workspaces/:sessionId/opencode/*`；Daytona Host 预览改写 |
| gzip 代理修复 | 已完成 | raw `http.request` 路径保留 `content-encoding`（曾导致 UI JSON 解析失败） |
| 公开错误契约 | 已完成 | `ApiError` / `toPublicErrorBody` / `ref`；见 [ERROR-CONTRACT.md](./ERROR-CONTRACT.md) |
| SSE 转发 | 已完成（控制面） | Broker 透传 SSE；`Last-Event-ID` 转发测试；运行时 `id:` 依赖 fork 镜像 |
| Runtime 镜像 | 已完成 | `opencode-runtime` / Daytona snapshot `sandbox-dev-opencode` |
| 验收脚本 | 已完成 | `scripts/verify-cloud-agent-mvp.mjs`；见 [PRODUCTION-VERIFY.md](./PRODUCTION-VERIFY.md) |

### 2.2 本地 Demo 链路

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 一键启动 | 已完成 | `scripts/start-cloud-agent-demo.ps1`（Daytona + Broker + gateway + inject + UI + md watcher） |
| Demo 网关 | 已完成 | `scripts/demo-web-gateway.mjs`：JWT、CORS、健康检查、租约 heartbeat |
| 模型注入 | 已完成 | DeepSeek 配置注入沙箱；模板 `deploy/local/opencode.demo.json`；密钥 gitignored |
| 模型目录补齐 | 已完成（demo） | gateway 合并 `/api/provider`、`/api/model`；补 `/api/model/default`（镜像缺路由时） |
| Web UI 联调 | 已完成 | `packages/app` :5173 → gateway :4096 → 沙箱 OpenCode |
| Markdown 回传主机 | 已完成（demo） | `demo-pull-md.mjs` / `--watch` → `demo-output/`；冒烟 `demo-verify-rw.mjs` |

### 2.3 端口映射（本机 demo）

| 端口 | 进程 | 浏览器是否直连 |
| --- | --- | --- |
| **5173** | Vite `packages/app` | 是（仅 UI 壳） |
| **4096** | `demo-web-gateway` | 是（UI 的 OpenCode API 基址） |
| **8080** | Broker | 否（gateway 使用） |
| **3000** | Daytona API | 否 |
| **4000** | Daytona proxy | 否（Broker → preview） |
| sandbox:4096 | `opencode serve` | 否（经 Broker 反代） |

URL 形态：`http://localhost:5173/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/<id>`  
其中 `aHR0cDovL2xvY2FsaG9zdDo0MDk2` = base64(`http://localhost:4096`)。

---

## 3. 能力边界（当前不做 / 未做实）

### 3.1 架构边界

- **控制面 ≠ OpenCode**：IAM、租约、计费、多供应商调度只在 `sandbox-dev`。
- **MVP 仅 exclusive**：一 workspace 一沙箱一 `opencode serve`；`multi_user_shared` / 拼车不进生产方案。
- **无宿主 bind-mount**：沙箱磁盘与 Windows 主机目录不共享；回传靠显式 pull（Broker `exec`），不是实时挂载。
- **Demo 网关不是生产网关**：CORS 放开、模型目录补齐、缺路由 shim 仅用于本机 UI 联调。
- **Hands plugin 旧路径仍在仓内**：本地 OpenCode 转发 bash/fs 到 Broker 的兼容模式保留，但不是云端 Agent 主路径。

### 3.2 运行时 / 产品缺口

| 边界 | 说明 |
| --- | --- |
| 沙箱镜像 ≠ fork 最新 | Daytona snapshot 多为上游 `opencode` 二进制；protocol 公共错误字段、SSE `id` 等 fork 改动**尚未进入运行中镜像** |
| v2 Catalog 与自定义 Provider | 上游 `available()` 主要认 `request.body.apiKey`；自定义 DeepSeek 依赖 **demo gateway 合并目录**，非运行时根治 |
| Broker 无一等 files API | Daytona 路径靠 `exec` 读写；sandbox-runtime 的 `files/read|write` 未挂到 Broker |
| 无 Git / Volume 自动同步 | `isGitSyncEnabled` 等未落地为 host↔sandbox 同步 |
| 事件恢复不完整 | 控制面可转发 `Last-Event-ID`；运行时侧可靠 `id` + 断线重放需 fork 镜像 + 更多验收 |
| Allowlist 未在网关强制 | 文档有 [OPENCODE-GATEWAY-ALLOWLIST](./OPENCODE-GATEWAY-ALLOWLIST.md)；demo 网关仍近乎全量反代 |
| AIO / E2B 云端 Agent 主路径 | Provider 能力在，OpenCode serve 主路径联调以 Daytona demo 为准 |
| 生产隔离级别 | 容器级（Daytona/E2B）；非 microVM / gVisor / Kata |
| Windows 沙箱 | Hands/沙箱为 Linux；见 [WINDOWS-CAPABILITY-BOUNDARIES](./WINDOWS-CAPABILITY-BOUNDARIES.md) |

### 3.3 安全与运维边界

- 本机 JWT secret / DeepSeek key 仅本地 secrets，**禁止提交**。
- Demo 注入会把 API key 写入**沙箱内** `opencode.json`（便于 v2 目录识别）；沙箱销毁前视为敏感。
- Redis 租约状态在异常退出后可能残留 `active_count` / queue，需清理或重建。
- `DAYTONA_API_URL` 在容器内必须是 `host.docker.internal`，宿主 shell 的 `localhost` 会覆盖 compose 并搞挂 Broker。

---

## 4. 未来优化点

### P0 — 运行时与网关硬化

1. **用 OpenCode fork 重建 runtime / Daytona snapshot**，使错误契约与 SSE `id` 真正生效于沙箱进程。  
2. **生产网关 allowlist**：按 [OPENCODE-GATEWAY-ALLOWLIST](./OPENCODE-GATEWAY-ALLOWLIST.md) 拒绝 credential / 任意插件安装等危险面。  
3. **根治模型目录**：在运行时/catalog 侧正确加载自定义 provider（或正式支持 `{file:}` / env），去掉 demo gateway 的目录 hack。  
4. **Broker `files/read|write`**：基于 Daytona SDK / runtime files API，替代脆弱的 `exec`+base64 pull。

### P1 — 工作区与同步

1. 可选 Daytona volume 或受控 sync，减少「写完再 pull」的 demo 感。  
2. Session / 工作区元数据持久化（DB），支持停止/恢复与审计。  
3. 事件断线恢复端到端验收（`Last-Event-ID` + 运行时 `id` + UI 重连）。

### P2 — 多 Provider 与隔离

1. E2B / AIO 用同一 `verify-cloud-agent-mvp` 跑通 OpenCode 主路径。  
2. 规划 microVM / 更强隔离作为生产默认。  
3. 容量与弹性：补全 [LOAD-CAPACITY](./LOAD-CAPACITY.md) / [ELASTIC-SCALING](./ELASTIC-SCALING.md) 在真实负载下的数据。

### P3 — 产品化

1. 正式 Identity（非本机共享 JWT secret）。  
2. 配额、计费、审计日志。  
3. 与 [FUTURE-WORK](./FUTURE-WORK.md) 中 CMA adapter 的可选对齐（不替代本控制面）。

---

## 5. 快速复现

```powershell
# 一键（需本机 Docker + Daytona 仓 E:\daytona + DeepSeek secrets）
powershell -File E:\sandbox-dev\scripts\start-cloud-agent-demo.ps1

# 冒烟：远程写 md → 主机 demo-output
node E:\sandbox-dev\scripts\demo-verify-rw.mjs

# 控制面验收
node E:\sandbox-dev\scripts\verify-cloud-agent-mvp.mjs
```

Web UI：`http://localhost:5173/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/<id>`  
主机 Markdown：`E:\sandbox-dev\demo-output\`

---

## 6. 专题文档索引

| 文档 | 内容 |
| --- | --- |
| [DEMO-MODEL-CONFIG.md](./DEMO-MODEL-CONFIG.md) | DeepSeek / Agent 配置注入 |
| [DEMO-FILE-SYNC.md](./DEMO-FILE-SYNC.md) | Markdown 回传主机 |
| [ERROR-CONTRACT.md](./ERROR-CONTRACT.md) | 公开错误体 |
| [EVENT-RECOVERY.md](./EVENT-RECOVERY.md) | SSE / Last-Event-ID |
| [OPENCODE-GATEWAY-ALLOWLIST.md](./OPENCODE-GATEWAY-ALLOWLIST.md) | 对外路由清单 |
| [OPENCODE-SANDBOX-PROVIDER-ASSESSMENT.md](./OPENCODE-SANDBOX-PROVIDER-ASSESSMENT.md) | Provider 评估 |
| [PRODUCTION-VERIFY.md](./PRODUCTION-VERIFY.md) | MVP 验收结果 |
| [FUTURE-WORK.md](./FUTURE-WORK.md) | CMA / Hands 长期演进 |
| [local-daytona-setup.md](./local-daytona-setup.md) | 本机 Daytona |

### OpenCode fork（并行仓）

分支 `cloud-agent-runtime` 上已有改动方向：

- Protocol 公共错误字段 / builders  
- Server handlers 使用稳定错误构造  
- SSE 帧写入事件 `id`  
- Client 再生码  

这些改动需打进 runtime 镜像后，沙箱内进程才会受益；在此之前生产验证以控制面行为 + 上游镜像能力为准。
