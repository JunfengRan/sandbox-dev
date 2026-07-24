# 弹性伸缩与进程资源上限

本仓库支持两层资源控制（双 provider：`daytona` | `e2b`）：

1. **沙箱包络（Sandbox envelope）**：控制每个沙箱在宿主机上占用的 CPU / 内存 / 磁盘上限（可创建时指定，可运行时 resize）。
2. **进程上限（Process limits）**：控制单次 `exec` 内进程的 CPU 时间、地址空间等硬顶（`prlimit` / `ulimit`）。

## 配置（Broker / Compose）

| 环境变量 | 含义 | 示例 |
|----------|------|------|
| `SANDBOX_SIZE_PROFILE` | `small` / `medium` / `large` / `custom` | `small` |
| `SANDBOX_CPU` | 默认 vCPU（覆盖 profile） | `0.5`（e2b）/ `1`（daytona 建议整数） |
| `SANDBOX_MEMORY_MIB` | 默认内存 MiB | `512` |
| `SANDBOX_DISK_GIB` | 默认磁盘 GiB（Daytona 生效） | `3` |
| `PROCESS_LIMIT_CPU_SECONDS` | 单次 exec CPU 时间秒 | `60` |
| `PROCESS_LIMIT_MEMORY_MIB` | 单次 exec 地址空间 MiB | `256` |
| `PROCESS_LIMIT_MAX_PROCESSES` | 可选 nproc | `128` |
| `PROCESS_LIMIT_MAX_OPEN_FILES` | 可选 nofile | `1024` |

内置 profile（[`SIZE_PROFILES`](../packages/shared/src/index.ts)）：

| Profile | CPU | Memory | Disk |
|---------|-----|--------|------|
| small | 0.5 | 512 MiB | 3 GiB |
| medium | 1 | 1 GiB | 5 GiB |
| large | 2 | 2 GiB | 10 GiB |

> Daytona SDK 要求 cpu/memory 为整数 GiB 级：实现里会对 cpu/memory **向上取整**（`Math.ceil`）。

## API

### 创建时指定规格

```http
POST /v1/leases/acquire
{
  "userId": "alice",
  "sessionId": "s1",
  "mode": "exclusive",
  "sizeProfile": "medium",
  "resources": { "cpu": 1, "memoryMiB": 1024, "diskGiB": 5 }
}
```

`resources` 优先于 `sizeProfile`，再回落到 Broker 默认。

### 运行时弹性 resize

```http
POST /v1/sandboxes/:id/resize
{ "cpu": 2, "memoryMiB": 2048, "diskGiB": 8 }
```

| Provider | 行为 |
|----------|------|
| **e2b** | `docker update` NanoCpus / Memory（热更新，已验证） |
| **daytona** | SDK `sandbox.resize()`；降配需先 stop（官方约束） |

### 状态

`GET /v1/status` 返回 `sizeProfile`、`defaultResources`、`processLimits`。

## 实测（E2B-compatible，2026-07-24）

| 检查 | 结果 |
|------|------|
| 创建默认 `0.5 vCPU / 512 MiB` | PASS |
| `resize` → `1 vCPU / 1024 MiB`，`docker inspect` NanoCpus=1e9 Memory=1GiB | **PASS** |
| `PROCESS_LIMIT_CPU_SECONDS=3` 下跑 `yes` 被 Kill，`EXIT:137` | **PASS** |
| 普通 `echo hello` | PASS |

## Daytona 说明

- **代码路径已接通**：create 带 `resources`，`resize` 调 SDK，exec 套 process limits。
- **本机负载/弹性联调**：Daytona Runner 被 API 标为 `UNRESPONSIVE`，`create` 返回 **502**（2026-07-24）。需在 `E:\daytona` 栈恢复 runner 心跳后再跑：

```powershell
# Runner 恢复 healthy 且 create 成功后：
$env:SANDBOX_PROVIDER=daytona
$env:SANDBOX_CPU=1
$env:SANDBOX_MEMORY_MIB=1024
.\scripts\bench-load-resources.ps1 -Provider daytona -AvgUsers 4 -OpsPerUser 10 -ExtremeUsers 8 -ExtremeOps 5
```

## 运维建议

- **每台服务器**：`MAX_SANDBOX_CONCURRENCY × SANDBOX_MEMORY_MIB` 勿超过物理 RAM 的 ~70%。
- **弹性**：高峰对活跃租约 `resize` 升配；空闲回落需 Daytona stop 或 e2b 热降配。
- **进程上限**：防止单工具 `yes`/OOM fork；coding agent 建议 `PROCESS_LIMIT_MEMORY_MIB` ≥ 512，避免误杀编译器。
