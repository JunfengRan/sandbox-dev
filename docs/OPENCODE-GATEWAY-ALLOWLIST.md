# OpenCode Gateway Allowlist

冻结云网关对沙箱内 `opencode serve` 的公开代理边界。本地 Client 只配置 Broker base URL；OpenCode 业务路径经：

`/v1/workspaces/:sessionId/opencode/*`

## 认证

- Broker 控制面与 OpenCode 代理均要求 `Authorization: Bearer <JWT>`
- 租户主体只取自 JWT（`user_id` / `userId`），忽略 body 中的 `userId`
- Broker 向沙箱内 OpenCode 注入内部 Basic Auth（`OPENCODE_SERVICE_PASSWORD`），不向客户端暴露

## 首期允许的 OpenCode 路径前缀

| 前缀 | 用途 |
| --- | --- |
| `/api/health` | 就绪探测 |
| `/api/location` | 工作区位置 |
| `/api/agent` | Agent 列表/选择 |
| `/api/session` | Session CRUD、prompt、history、interrupt、wait |
| `/api/event` | 全局 SSE |
| `/api/session/*/event` | Session 级 SSE |
| `/api/session/*/message` | 消息读写 |
| `/api/session/*/permission` | 权限问答 |
| `/api/session/*/question` | 澄清问答 |
| `/api/session/*/model` | Session 模型 |
| `/api/provider` | Provider 只读 |
| `/api/model` | Model 只读 |
| `/api/config` | 只读配置（不含写密钥） |
| `/api/file` / `/api/find` / `/api/ripgrep` | 文件与搜索（若镜像暴露） |
| `/api/command` / `/api/skill` | 命令与 skill |

OpenAPI 对照：经网关访问 `/doc`（不是 `/openapi.json`）。E2B 探针实测 `title=opencode`、`version=1.0.0`、约 162 paths。

## 明确不直接暴露

- credential / secret 写入接口
- integration / 任意远程插件安装
- 旧 TUI / control / global workspace 管理接口
- 沙箱 provider-internal endpoint、Daytona signed preview URL、容器 IP:4096
- `sandbox-runtime` 的 `/v1/sandboxes/*/services/*/proxy`（仅 Broker 内部使用）

## 兼容策略

- 云网关不裁剪上游 OpenAPI 生成面时，仍按本 allowlist 做产品层限制
- 版本策略：记录运行时镜像 digest / OpenCode 版本；Client 以 `/doc` + 本 allowlist 生成 SDK
- SSE：透传 `server.connected`、帧 `id:`（= EventV2 `evt_…`）与 heartbeat；禁止代理缓冲
- 断线恢复（MVP）：Client 先拉 Session/Message（必要时 `session.history` / `session.events?after=`）快照，再重订 `/api/event`；不假设全局 SSE 可按 `Last-Event-ID` 无损补发
- `Last-Event-ID`：网关原样转发；上游全局 `/api/event` 当前忽略（live-only stub）

## Provider 角色

- **E2B-compatible（当前默认）**：功能探针与本地联调主路径；容器级隔离，不是最终多租户安全边界
- **Daytona / AIO**：完成 E2B 联调后扩展验证的工作区/运行时方案
- **Firecracker / gVisor / Kata**：不可信多租户生产隔离的目标方向；不由当前 Windows Docker Desktop 路径承担
