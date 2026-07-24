# 未来工作

本文件记录与 [Claude Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) 对齐评审后的结论，以及后续演进项。  
评审日期：2026-07-24。

## 当前定位（结论）

本仓库是 CMA 分层中的 **Hands / 自托管执行面（控制面）**，不是完整 CMA 产品：

| 职责 | 本仓库 | 说明 |
|------|--------|------|
| Brain / Harness | 否 | Agent loop、Events SSE 由上游（如 OpenCode）负责 |
| Hands / Environment | 是 | 租约、槽位、排队、sandbox 生命周期、工具隔离 |
| Anthropic Environments Work 对接 | 否 | 范式同构，协议未接入 |

**总体判断：方向对齐，边界正确。** 若要更深贴合官方 CMA，应在现有 Broker 上增加 adapter，而不是重做控制面。

对照四原语：

| CMA 概念 | 本仓库 | 对齐度 |
|----------|--------|--------|
| Agent | 不实现 | —（配置在上游 harness） |
| Environment / Hands | Broker + `SandboxProvider`（Daytona / E2B-compatible） | 高 |
| Session → sandbox | lease acquire / release / heartbeat | 高 |
| Events | OpenCode `session.idle` / `session.deleted` | 低（本地事件，非 CMA Events API） |
| Environment worker | 自有 Kafka / lease 队列 | 低（未 claim Anthropic work） |

已对齐能力：Brain/Hands 分层、`SandboxProvider` 生命周期、session 绑定与 idle 释放、多 provider、弹性规格与进程 ulimit。

已知差距（与 [README 已知限制](../README.md#已知限制) 一致）：

- 未实现 Anthropic Environments Work 轮询与 tool result 回传
- 无 Agent / Environment / Events 一等资源模型
- E2B 路径为容器兼容 API，非 Firecracker 多租户边界
- `multi_user_shared` 为实验（`ocuser_*` hash 碰撞风险）
- `IdlePolicy: pool` 未实现

参考文档：

- [Managed Agents overview](https://platform.claude.com/docs/en/managed-agents/overview)
- [Self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)

## 后续工作项

按优先级排列；未排期，可按产品目标裁剪。

### P0 — 保持 Hands 边界，可选 CMA adapter

在现有 lease / `SandboxProvider` 之上增加可选适配层（不替换控制面）：

1. Claim Anthropic Environments Work 队列中的工作项  
2. 映射到现有 lease → sandbox  
3. 本地 `exec` / files  
4. Post tool result 回 Anthropic  

验收：能用官方 self-hosted environment 跑通一次 bash/file 工具调用闭环。

### P1 — 对外语义对齐（命名层）

- API / 文档逐步对齐 Environment / Session 用语（内部可继续用 lease）  
- 明确区分「本仓 Session」与「CMA Session / Events」以免混淆  

### P2 — 生产隔离与共享模式

- 生产默认继续 `exclusive`  
- 真多租户边界（microVM / 更强隔离）后再评估拼车  
- 补齐或正式废弃 `IdlePolicy: pool`  
- 场景 3：降低 `ocuser_*` 碰撞风险，或限制为实验-only  

### P3 — 容量与弹性（延续已有文档）

- Daytona Runner 可用后补全 [LOAD-CAPACITY](LOAD-CAPACITY.md) 极限态  
- 按 [ELASTIC-SCALING](ELASTIC-SCALING.md) 验证 resize / process limits 在真实负载下的行为  

## 明确不做（本仓范围外）

- 完整 Messages / Responses agent loop  
- CMA Session Events SSE 托管 harness  
- 替代 Anthropic 侧模型编排与 prompt caching / compaction  
