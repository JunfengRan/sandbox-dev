# Testing Guide

This document records **how to run validation**, **observed results**, and **resource planning estimates** for each Broker mode and provider (`daytona` | `e2b`).

## Prerequisites

### E2B-compatible（推荐本地默认）

| Service | Check |
|---------|-------|
| sandbox-runtime | `Invoke-RestMethod http://localhost:8090/health` → `ok` |
| Broker | `Invoke-RestMethod http://localhost:8080/health` → `ok` |
| Redis / Redpanda | `docker ps` shows `local-redis-1`, `local-redpanda-1` healthy |
| Image | `sandbox-dev/e2b-runtime:0.1.0`（`.\scripts\build-e2b-image.ps1`） |
| Broker env | `deploy/local/.env` 中 `SANDBOX_PROVIDER=e2b` |

### Daytona（保留路径）

| Service | Check |
|---------|-------|
| Daytona API | `Invoke-RestMethod http://localhost:3000/api/health` → `ok` |
| Broker | `SANDBOX_PROVIDER=daytona` + valid `DAYTONA_API_KEY` |
| Scenario 3 | `DAYTONA_SNAPSHOT=sandbox-dev-multi-user` + snapshot `0.1.1` active |

Reset broker state before a clean run:

```powershell
docker exec local-redis-1 redis-cli FLUSHALL
```

## Test Scripts

| Script | Mode | What it validates |
|--------|------|-------------------|
| `scripts/test-scenario1-queue.ps1` | `exclusive` | Concurrency cap + Kafka queue + idle dequeue |
| `scripts/test-scenario2-multi-session.ps1` | `user_shared` | Same sandboxId, different workDir |
| `scripts/test-scenario3-multi-user.ps1` | `multi_user_shared` | Shared pool, `ocuser_*`, OS file isolation |
| `scripts/test-scenario3-isolation.mjs` | — | Provider-aware sudo / UID isolation probe |
| `scripts/run-all-tests.ps1 -Provider e2b\|daytona` | all | End-to-end summary |
| `scripts/measure-e2b-resources.ps1` | — | `docker stats` for E2B-compatible sandboxes |
| `scripts/bench-load-resources.ps1` | exclusive | 平均态 / 极限态 CPU·内存采样 |
| `scripts/build-e2b-image.ps1` | — | Build `sandbox-dev/e2b-runtime` |

### Run all (E2B-compatible)

```powershell
cd E:\sandbox-dev
.\scripts\build-e2b-image.ps1
cd deploy\local
docker compose up -d --build
cd ..\..
docker exec local-redis-1 redis-cli FLUSHALL
.\scripts\run-all-tests.ps1 -Provider e2b
.\scripts\measure-e2b-resources.ps1
```

### Run all (Daytona)

```powershell
# .env: SANDBOX_PROVIDER=daytona + DAYTONA_API_KEY
.\scripts\run-all-tests.ps1 -Provider daytona
```

## Test Results — E2B-compatible (2026-07-24, local Docker)

Environment: Windows 11, Docker Desktop, `SANDBOX_PROVIDER=e2b`, image `sandbox-dev/e2b-runtime:0.1.0`, `MAX_SANDBOX_CONCURRENCY=2`, default limits **0.5 vCPU / 512 MiB** per sandbox.

### Scenario 1 — Concurrency queue

| Step | Expected | Result |
|------|----------|--------|
| user-a / user-b acquire | `200 granted` | **PASS** |
| user-c acquire | `202 queued` | **PASS** |
| user-a idle release → poll user-c | `status=ready` | **PASS** |

### Scenario 2 — Same user, multiple sessions

| Step | Expected | Result |
|------|----------|--------|
| Two acquires, same `userId` | Same `sandboxId` | **PASS** |
| workDir | `/home/user/project/sessions/<sessionId>` | **PASS** |
| File in session-a, read from session-b dir | NOT_FOUND | **PASS** |

### Scenario 3 — Multi-user carpool

| Step | Expected | Result |
|------|----------|--------|
| user-a / user-b same pool | Same `sandboxId` | **PASS** |
| Linux user mapping | Different `ocuser_XXX` | **PASS** (`ocuser_029` vs `ocuser_019`) |
| user-b reads user-a secret | DENIED | **PASS** |

**Summary:** Scenario 1–3 all **PASS** on E2B-compatible provider.

### Observed `docker stats` (idle / light write)

| Sample | CPU % | Mem usage / limit |
|--------|-------|-------------------|
| exclusive idle | ~0% | **~2.3 MiB / 512 MiB** |
| exclusive after `dd` 32MiB write | ~0% | **~2.1 MiB / 512 MiB** |
| user_shared (2 sessions) | ~0% | **~1.8 MiB / 512 MiB** |
| multi_user_shared (2 users) | ~0% | **~2.2 MiB / 512 MiB** |

> Idle RSS 极低是因为镜像入口为 `sleep infinity`、无语言服务器；**规划容量仍应按 limit + agent 负载**（见下表），不要用 2 MiB 做生产估算。

### Control plane（`deploy/local`，实测）

| Component | Observed RSS | Notes |
|-----------|--------------|-------|
| Redis | ~10 MiB | leases / slots |
| Redpanda | ~240–250 MiB | acquire queue（compose `--memory 512M`） |
| Broker (Node) | ~40 MiB | API + Kafka consumer |
| sandbox-runtime | ~24 MiB | dockerode orchestrator |
| **Subtotal** | **~0.3–0.35 GiB** | 不含 Daytona 平台；比「Daytona + Broker」整栈轻 |

## Test Results — Daytona (2026-07-24, local)

Environment: Windows 11, Docker Desktop, Daytona self-hosted v0.190, Broker on Node 20, `MAX_SANDBOX_CONCURRENCY=2`, snapshot `sandbox-dev-multi-user:0.1.1`.

### Scenario 1 — Concurrency queue

| Step | Expected | Result |
|------|----------|--------|
| user-a acquire | `200 granted` | **PASS** |
| user-b acquire | `200 granted` | **PASS** |
| user-c acquire | `202 queued` | **PASS** |
| user-a idle release → poll user-c | `status=ready` | **PASS** |

### Scenario 2 — Same user, multiple sessions

| Step | Expected | Result |
|------|----------|--------|
| Two acquires, same `userId` | Same `sandboxId` | **PASS** |
| workDir | `/home/daytona/project/sessions/<sessionId>` | **PASS** |
| File in session-a, read from session-b dir | NOT_FOUND / no access | **PASS** |

### Scenario 3 — Multi-user carpool

| Step | Expected | Result |
|------|----------|--------|
| user-a / user-b same pool | Same `sandboxId` | **PASS** |
| Linux user mapping | Different `ocuser_XXX` | **PASS** (`ocuser_032` vs `ocuser_001`) |
| user-b reads user-a secret file | DENIED / Permission denied | **PASS** |
| API layer summary | PASS | **PASS** |
| OS isolation summary | PASS | **PASS** |

> Before multi-user snapshot: API layer passed but OS isolation **FAIL** (`runuser` / missing `ocuser_*`). After `0.1.1` (sudo + sudoers): full **PASS**.

## Resource Planning

### Provider defaults

| Provider | CPU limit / sandbox | Memory limit / sandbox | Isolation |
|----------|---------------------|------------------------|-----------|
| Daytona（默认 snapshot） | 1 vCPU | 1 GiB | 容器（Daytona runner） |
| E2B-compatible（本仓库） | **0.5 vCPU** | **512 MiB** | 容器（dockerode）；非 Firecracker |

Observed idle sandbox RSS:

- Daytona slim started: **~150–300 MiB**；active agent: **400 MiB–1 GiB+**
- E2B-compatible `sleep infinity`: **~2 MiB**；规划仍按 **256–512 MiB** 活动负载预留

### Mode comparison（规划用）

| Mode | Daytona CPU/user | Daytona Mem/user | E2B-compatible CPU/user | E2B-compatible Mem/user |
|------|------------------|------------------|-------------------------|-------------------------|
| `exclusive` | 1 vCPU | 1 GiB | 0.5 vCPU | 512 MiB |
| `user_shared`（N sessions） | 1÷N | 1 GiB÷N | 0.5÷N | 512 MiB÷N |
| `multi_user_shared`（4 人舒适） | ~0.5（建议 2vCPU/2GiB 容器） | ~512 MiB | ~0.25（建议 1vCPU/1GiB 或保持 0.5/512） | ~128–256 MiB |

### E2B-compatible carpool 建议

| Pool 活跃用户 | 推荐 CPU limit | 推荐 RAM limit |
|---------------|---------------|----------------|
| 1–2 | 0.5–1 vCPU | 512 MiB–1 GiB |
| 3–4 | 1–2 vCPU | 1–2 GiB |
| 5+ | 拆 pool 或 `exclusive` | — |

### 容量示例（E2B-compatible, `MAX_SANDBOX_CONCURRENCY=10`, exclusive）

| Resource | Calculation | Estimate |
|----------|-------------|----------|
| Sandbox RAM limit | 10 × 512 MiB | 5 GiB |
| Sandbox CPU limit | 10 × 0.5 | 5 vCPU |
| Broker + runtime stack | fixed | ~0.35–0.5 GiB |
| **vs Daytona exclusive×10** | 10 × 1 GiB + Daytona 平台 4–6 GiB | **明显更轻**（无 Daytona 控制面，默认 limit 减半） |

Trade-off: E2B-compatible **更轻、全 Docker、无第三方云**，但隔离仍是 **共享内核容器**，不能替代真 microVM。

## 平均态 / 极限态负载（2026-07-24）

详见 **[LOAD-CAPACITY.md](LOAD-CAPACITY.md)** 与 **[ELASTIC-SCALING.md](ELASTIC-SCALING.md)**。

| Provider | 平均态 4×10 rw | 极限态 | 规划要点 |
|----------|----------------|--------|----------|
| E2B-compatible | PASS（峰值 CPU 27%、RSS 13 MiB） | PASS（16 用户，CPU 29%、RSS 20 MiB） | limit **0.5×N / 512×N MiB** |
| Daytona | **BLOCKED**（Runner 502） | **BLOCKED** | 规划 **1×N vCPU / N GiB**；待 Runner 恢复补测 |

## CI vs local integration tests

GitHub Actions runs **build + typecheck only**（含 `sandbox-runtime`）。Full scenario tests require Docker locally:

```powershell
.\scripts\run-all-tests.ps1 -Provider e2b
```

See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
