# Testing Guide

This document records **how to run validation**, **observed results** (local Daytona v0.190, Windows), and **resource planning estimates** for each Broker mode.

## Prerequisites

| Service | Check |
|---------|-------|
| Daytona API | `Invoke-RestMethod http://localhost:3000/api/health` → `ok` |
| Broker | `Invoke-RestMethod http://localhost:8080/health` → `ok` |
| Redis / Redpanda | `docker ps` shows `local-redis-1`, `local-redpanda-1` healthy |
| Broker env | `deploy/local/.env` with valid `DAYTONA_API_KEY` |
| Scenario 3 | `DAYTONA_SNAPSHOT=sandbox-dev-multi-user` + snapshot `0.1.1` active |

Reset broker state before a clean run:

```powershell
docker exec local-redis-1 redis-cli FLUSHALL
```

## Test Scripts

| Script | Mode | What it validates |
|--------|------|-------------------|
| `scripts/test-scenario1-queue.ps1` | `exclusive` | Concurrency cap + Kafka queue + idle dequeue |
| `scripts/test-scenario2-multi-session.ps1` | `user_shared` | Same sandboxId, different workDir, file isolation |
| `scripts/test-scenario3-multi-user.ps1` | `multi_user_shared` | Shared pool sandbox, different `ocuser_*`, OS file isolation |
| `scripts/test-scenario3-isolation.mjs` | — | Low-level sudo / UID isolation probe (called by scenario 3 script) |
| `scripts/run-all-tests.ps1` | all | End-to-end summary for scenarios 1–3 |

### Run individually

```powershell
cd E:\sandbox-dev
.\scripts\test-scenario1-queue.ps1
.\scripts\test-scenario2-multi-session.ps1
.\scripts\test-scenario3-multi-user.ps1
```

### Run all

```powershell
.\scripts\run-all-tests.ps1
```

### Scenario 3 isolation (manual)

```powershell
$env:DAYTONA_API_URL = 'http://localhost:3000/api'
$env:DAYTONA_API_KEY = '<your-key>'
node scripts/test-scenario3-isolation.mjs <sandboxId> ocuser_032 ocuser_001 /home/ocuser_032/project/sessions/session-a
# Expect: HAS_LINUX_USER:yes, ISOLATION_RESULT:DENIED, ISOLATION_PASS:yes
```

## Test Results (2026-07-24, local)

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

Estimates below use Daytona default snapshot limits (**1 vCPU, 1 GiB RAM, 3 GiB disk** per sandbox) unless overridden. Agent workloads vary widely; treat numbers as **starting points**, not SLAs.

### Per-container / instance (sandbox)

| Snapshot | CPU (request) | Memory | Disk | Notes |
|----------|---------------|--------|------|-------|
| `daytonaio/sandbox:0.5.0-slim` | 1 vCPU | 1 GiB | 3 GiB | Default; no git |
| `sandbox-dev-multi-user:0.1.1` | 1 vCPU | 1 GiB | 3 GiB | +32 `ocuser_*` accounts, bubblewrap, sudoers |
| Recommended (heavy agents) | 2 vCPU | 2 GiB | 5 GiB | npm install, dev servers, parallel tools |

Observed idle sandbox RSS (slim, started): ~150–300 MiB. Under active agent load: 400 MiB–1 GiB+.

### Broker control plane (this repo, `deploy/local`)

| Component | Configured / typical | Purpose |
|-----------|----------------------|---------|
| Redis | ~50–100 MiB | Lease slots, user/pool mapping |
| Redpanda | 512 MiB (`--memory 512M`) | Acquire queue |
| Broker (Node) | ~100–200 MiB | API + Kafka consumer |
| **Subtotal** | **~0.7–1 GiB** | Fixed overhead regardless of sandbox count |

### Mode comparison

| Mode | Sandboxes needed | Users per sandbox | Concurrent sessions per sandbox | CPU / user (theoretical*) | Memory / user (theoretical*) |
|------|------------------|-------------------|---------------------------------|---------------------------|------------------------------|
| `exclusive` | 1 per session | 1 | 1 | 1 vCPU | 1 GiB |
| `user_shared` | 1 per `user_id` | 1 user | N sessions (directory isolated) | 1 vCPU ÷ N active sessions | 1 GiB ÷ N active sessions |
| `multi_user_shared` (carpool) | 1 per pool | up to 32 UID slots† | 2–4 comfortable‡ | 0.25–0.5 vCPU | 256–512 MiB |

\* Theoretical equal split when all users are CPU/RAM active simultaneously. Linux scheduling and I/O bursts mean real usage is spikier.

† `hashUserToLinuxUser()` maps to `ocuser_001..032`; hash collisions possible.

‡ **Practical carpool concurrency** (semi-trusted internal use):

| Pool size (active users) | Recommended sandbox CPU | Recommended sandbox RAM | Rationale |
|--------------------------|-------------------------|-------------------------|-----------|
| 1–2 | 1 vCPU | 1 GiB | Matches defaults; light coding agents |
| 3–4 | 2 vCPU | 2 GiB | Parallel npm/pip, language servers |
| 5–8 | 2–4 vCPU | 4 GiB | Diminishing returns; consider second pool sandbox |
| 9+ | — | — | Not recommended on single container; split pools or use `exclusive` |

### Server capacity example

With `MAX_SANDBOX_CONCURRENCY=10` and **exclusive** mode:

| Resource | Calculation | Estimate |
|----------|-------------|----------|
| Sandbox RAM | 10 × 1 GiB | 10 GiB |
| Sandbox CPU | 10 × 1 vCPU | 10 vCPU |
| Broker stack | fixed | ~1 GiB, ~0.5 vCPU |
| Daytona platform | api + runner + db + … | ~4–6 GiB (local Docker Desktop) |
| **Headroom (20%)** | | +2–3 GiB |
| **Total (sandboxes only)** | | **~12 GiB RAM, 11 vCPU** |

Same host with **one carpool sandbox** and 4 active users (2 vCPU / 2 GiB sandbox):

| Resource | Estimate |
|----------|----------|
| Sandbox | 2 vCPU, 2 GiB |
| Per active user (avg) | ~0.5 vCPU, ~512 MiB |
| vs 4× exclusive | **~50% RAM/CPU savings** (single kernel, shared base image) |

Trade-off: carpool saves resources but **does not** provide VM-level tenant isolation.

## CI vs local integration tests

GitHub Actions runs **build + typecheck only** (no Daytona/Docker integration). Full scenario tests require a running Daytona stack — run locally with the scripts above.

See [`.github/workflows/ci.yml`](../.github/workflows/ci.yml).
