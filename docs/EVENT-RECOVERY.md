# Event Recovery

## MVP（已冻结）

1. 连接 `/api/event` 后先收到带 SSE `id` 的 `server.connected`，随后是 live 事件。
2. Heartbeat 为注释行 `: heartbeat`，不带 id。
3. 断线后：**先 REST 拉快照，再重订 SSE**。不要依赖全局流补发。
4. Broker / sandbox-runtime 对 SSE 做 chunk 透传，保留 `cache-control` / `x-accel-buffering: no`，并转发 `Last-Event-ID`。

## Phase-2（未做）

- 按租户/工作区授权后，对 durable session aggregate 使用 `session.events?after=` 补发，再切 live。
- 瞬时 delta 明确标记为“必须重取快照”。
- EventV2 replay owner claim 与 Session 执行所有权保持分离。
