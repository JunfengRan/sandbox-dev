# 负载容量实测：平均态 vs 极限态

本文档记录 **E2B-compatible** 与 **Daytona** 在两类负载下的 CPU/内存结果（或阻塞原因）。  
复现脚本：[`scripts/bench-load-resources.ps1`](../scripts/bench-load-resources.ps1)（`-Provider e2b|daytona`）  
弹性伸缩：[`ELASTIC-SCALING.md`](ELASTIC-SCALING.md)

## 场景定义

### 平均态（Average）

- **4** 个并发用户，每用户 **10** 次读写
- 用户之间并行；单用户内顺序执行

### 极限态（Extreme）

- 多用户同时进入（受 `MAX_SANDBOX_CONCURRENCY` 限制）
- 每用户 **强制单操作锁**（`Mutex`）
- 每用户若干次读写（含轻量 `dd`）

---

## E2B-compatible 实测（2026-07-24）PASS

| 项 | 值 |
|----|----|
| Provider | `e2b` |
| 默认 limit | **0.5 vCPU / 512 MiB** |
| Concurrency | **16** |
| JSON | [`bench-results/load-bench-20260724-170754.json`](bench-results/load-bench-20260724-170754.json) |

| 指标 | 平均态（4 用户） | 极限态（16 用户） |
|------|------------------|-------------------|
| 耗时 | **17.3 s** | **42.6 s** |
| Sandbox CPU 峰值（合计） | **27.1%** | **29.4%** |
| Sandbox 内存峰值（合计 RSS） | **13.2 MiB** | **19.8 MiB** |
| 控制面内存峰值 | **308 MiB** | **325 MiB** |
| 规划 limit 合计 | **2 vCPU / 2 GiB** | **8 vCPU / 8 GiB** |

---

## Daytona 实测（2026-07-24）BLOCKED

| 项 | 值 |
|----|----|
| Provider | `daytona`（host broker + 本地 Daytona API） |
| 计划规格 | **1 vCPU / 1 GiB** / sandbox（Daytona 整数资源） |
| 计划负载 | Avg 4×10 rw；Extreme 8×5 rw + 单操作锁 |

**阻塞原因**：Daytona API 将 Runner 标为 `UNRESPONSIVE`，`daytona.create()` 持续返回 **HTTP 502**（`GET /api/health` 仍为 ok，但无法创建 sandbox）。已尝试重启 api/runner/proxy/redis，问题依旧。

```text
DaytonaError: Request failed with status code 502
RunnerService: v2 Runner ... marking as UNRESPONSIVE
```

**此前功能回归**（Runner 健康时，见 [`TESTING.md`](TESTING.md)）：场景 1–3 API/OS 隔离曾 **PASS**。负载采样需 Runner 恢复后补跑：

```powershell
.\scripts\bench-load-resources.ps1 -Provider daytona -AvgUsers 4 -OpsPerUser 10 -ExtremeUsers 8 -ExtremeOps 5
```

**规划对照（Runner 未恢复时的 limit 估算）**：

| 场景 | 并发 N | Daytona 规划 CPU | Daytona 规划 Mem |
|------|--------|------------------|------------------|
| 平均态 | 4 | **4 vCPU** | **4 GiB** |
| 极限态 | 8 | **8 vCPU** | **8 GiB** |
| vs 同并发 E2B | — | 约为 E2B 的 **2×**（1/1 vs 0.5/512） | 同左 |

JSON：[`bench-results/load-bench-daytona-blocked-20260724.json`](bench-results/load-bench-daytona-blocked-20260724.json)

---

## 规划公式（两 provider）

| | E2B-compatible | Daytona（默认） |
|--|----------------|-----------------|
| 每用户 limit | 0.5 vCPU / 512 MiB | 1 vCPU / 1 GiB |
| N 用户 exclusive | `0.5N` vCPU / `512N` MiB | `N` vCPU / `N` GiB |
| 控制面 | ~0.3–0.4 GiB | Broker + **Daytona 整栈数 GiB** |

弹性升配/进程硬顶见 [ELASTIC-SCALING.md](ELASTIC-SCALING.md)。
