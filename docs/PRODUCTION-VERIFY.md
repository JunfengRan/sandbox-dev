# Cloud Agent MVP 生产验证

验收脚本：`node scripts/verify-cloud-agent-mvp.mjs`

当前 Daytona 路径结果（2026-08-06，Broker 重建后）：

| 检查 | 结果 |
| --- | --- |
| 无 JWT → `AUTH.REQUIRED` + `ref` | PASS |
| exclusive acquire | PASS |
| 跨租户 exec → `AUTH.FORBIDDEN` | PASS |
| 网关 `/api/health` | PASS |
| 网关创建 Session | PASS |
| SSE `server.connected` + 透传 | PASS |
| SSE 帧 `id: evt_…` | 待 fork 运行时镜像重建（现镜像仍为上游 `ghcr.io/anomalyco/opencode`） |
| release | PASS |

## 仍待

- 从 OpenCode fork 构建并注册新的 `opencode-runtime` / Daytona snapshot，以带上 protocol 错误字段与 SSE `id`
- E2B-compatible 与 AIO 用同一脚本各跑一遍（切换 compose env）
- AIO 未作为 OpenCode 主路径联调
