# OpenCode 沙箱 Provider 能力评估

评估日期：2026-08-05 / 2026-08-06

## 结论

**当前默认的 E2B-compatible（自托管 Docker）足以承载首期 `opencode serve` 功能联调，但不足以作为最终多租户生产隔离边界。**  
因此：E2B 路径用于契约冻结与日常联调；完成后扩展 Daytona / AIO，生产不可信代码目标落到 microVM / gVisor / Kata。

## E2B-compatible：能做什么

已用 `sandbox-dev/opencode-runtime` + Broker 网关验证：

- `opencode serve` 服务生命周期（start / ready / proxy）
- REST：`/api/health`、`/api/location`、`/api/session`
- SSE：`server.connected` + heartbeat（经 Broker `/v1/workspaces/:sessionId/opencode`）
- JWT 强制鉴权、租户主体不可伪造、跨租户 lease 拒绝
- 沙箱 stop/start 后 Session 恢复
- OpenAPI `/doc`（约 162 paths）

镜像内工具基线：bash、git、ssh、ripgrep、sudo，可覆盖常见 Agent shell/fs/git 路径。

## E2B-compatible：不能当作最终方案的原因

1. **隔离级别**：本仓 E2B 是 Docker 容器 API 兼容层，不是 Firecracker microVM；共享宿主内核。
2. **多租户威胁模型**：不可信 Agent 代码需要更强的内核/syscall 隔离；普通 Docker 不够。
3. **产品能力缺口**：PTY WebSocket、durable event replay、批准插件策略、完整浏览器/GUI 工具链仍待补齐；Windows 专属能力不在 Linux 沙箱内。
4. **平台限制**：真 Firecracker / 官方 E2B infra 需要 Linux + KVM，无法作为 Windows Docker Desktop 默认路径。

## 扩展顺序

| Provider | 角色 | 状态 |
| --- | --- | --- |
| E2B-compatible | 本地联调、契约、网关安全主路径 | 功能探针已通过 |
| Daytona | 持久工作区、signed preview、产品化运维 | 服务契约已实现；使用预装 OpenCode snapshot 做端到端探针 |
| AIO | 更重运行时 / 专用网络对照 | 排在 Daytona 之后 |
| Firecracker / gVisor / Kata | 不可信多租户生产隔离 | 目标方向，非当前 Windows 默认路径 |

## 网关边界

详见 [OPENCODE-GATEWAY-ALLOWLIST.md](./OPENCODE-GATEWAY-ALLOWLIST.md)。
