# Error Contract

Broker、sandbox-runtime 与 OpenCode protocol 共用同一公开错误信封：

```json
{
  "code": "AUTH.REQUIRED",
  "message": "Authentication required",
  "retryable": false,
  "ref": "err_a1b2c3d4e5f6",
  "causes": [{ "code": "STATE.MISS", "message": "missing lease" }]
}
```

## 规则

- 客户端业务判断依赖稳定 `code`，HTTP 状态只表达传输语义。
- `ref` 用于关联服务端完整日志；公开响应永不返回 Secret。
- `causes` 限深、脱敏；5xx 对外隐藏 message/causes，只保留 `code`/`retryable`/`ref`。
- OpenCode 侧额外保留 `_tag`（Effect TaggedError）；`code` 为云端稳定码，例如 `SESSION.NOT_FOUND`、`AUTH.REQUIRED`、`INTERNAL.UNKNOWN`。

## sandbox-dev 码域

| 前缀 | 含义 |
| --- | --- |
| `AUTH.*` | 网关鉴权/授权 |
| `SANDBOX.*` | 租约、服务生命周期、启动失败 |
| `RUNTIME.*` | sandbox-runtime 入参与本地编排 |
| `INTERNAL.*` | 未知失败 |

实现：`packages/shared/src/errors.ts`，Broker/runtime 错误中间件均经 `toPublicErrorBody`。
