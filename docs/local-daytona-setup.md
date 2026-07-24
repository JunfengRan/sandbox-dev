# Local Daytona Sandbox: Setup & Debugging

Guide for running **Daytona self-hosted** locally (Docker Compose) and integrating with **OpenCode** and the **Sandbox Broker** (`sandbox-dev`).

> **Last updated:** 2026-07-24

---

## Table of contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Network & proxy (Clash / Docker Hub)](#network--proxy-clash--docker-hub)
- [1. Start Daytona](#1-start-daytona)
- [2. Configure OpenCode](#2-configure-opencode)
- [3. Verify OpenCode](#3-verify-opencode)
- [4. Sandbox Broker (this repo)](#4-sandbox-broker-this-repo)
- [5. Debugging](#5-debugging)
- [6. Known issues](#6-known-issues)
- [7. Reference paths](#7-reference-paths)
- [8. Quick checklist](#8-quick-checklist)

---

## Architecture

```
OpenCode (TUI/CLI, Windows/macOS/Linux)
    │  plugin: @sandbox-dev/opencode-plugin  (or @daytona/opencode)
    ▼
Sandbox Broker (:8080)  ── optional; Redis + Kafka queue
    ▼
Daytona API  http://localhost:3000/api
    │
    ├── Runner   (creates sandbox containers)
    ├── Proxy    http://127.0.0.1:4000  (Toolbox)
    └── Dashboard http://localhost:3000
```

- **Daytona deployment (self-hosted):** e.g. `E:\daytona` from [daytonaio/daytona](https://github.com/daytonaio/daytona) v0.190.0
- **Maintained SDK / plugins:** [github.com/daytona](https://github.com/daytona) (`@daytona/sdk`, `@daytona/opencode`)

---

## Prerequisites

| Item | Requirement |
|------|-------------|
| Docker Desktop | Running; WSL2 backend on Windows |
| RAM | ≥ 8 GiB free for Daytona stack; +1 GiB for Broker stack |
| Git | Project dir must be `git init` (OpenCode sync / plugin expectations) |
| OpenCode CLI | Installed (tested with 1.18.x) |
| Node.js | ≥ 20 (Broker local dev) |

---

## Network & proxy (Clash / Docker Hub)

Docker image pulls and Cursor/IDE stability often conflict on Windows:

| Clash proxy | Docker Hub pulls | Cursor / IDE |
|-------------|------------------|--------------|
| **ON** | Usually works | May disconnect occasionally |
| **OFF** | May fail (`auth.docker.io` EOF / 502) | Usually stable |

**Recommendations:**

1. **First-time setup:** turn Clash **on**, configure Docker Desktop → Settings → Resources → Proxies (`http://127.0.0.1:7890` or your port), pull all images, then you can turn Clash **off** for daily dev if images are cached.
2. **Daytona images already cached:** Clash can stay **off**; rebuilds use local registry (`localhost:6000`) for custom snapshots.
3. **Debian apt inside Dockerfile builds:** mirror 502 errors are common; build incremental layers (see `snapshots/Dockerfile.multi-user` BASE_IMAGE) or retry when mirrors recover.
4. Do **not** commit proxy credentials or API keys.

---

## 1. Start Daytona

### 1.1 Start services

```powershell
cd E:\daytona
docker compose -f docker/docker-compose.yaml up -d
```

### 1.2 Check status

```powershell
docker compose -f docker/docker-compose.yaml ps
```

| Service | Port | Role |
|---------|------|------|
| `daytona-api-1` | 3000 | API + Dashboard |
| `daytona-runner-1` | 3003 | Sandbox runner |
| `daytona-proxy-1` | 4000 | Toolbox proxy |
| `daytona-registry-1` | 6000 | Local image registry |

### 1.3 Health check

```powershell
Invoke-RestMethod http://localhost:3000/api/health
# Expected: status = ok
```

### 1.4 Dashboard

- URL: http://localhost:3000
- Default login: `dev@daytona.io` / `password`
- Snapshots: http://localhost:3000/dashboard/snapshots — ensure default snapshot is **active**
- For scenario 3: register `sandbox-dev-multi-user` (image `registry:6000/daytona/sandbox-dev-multi-user:0.1.1`)

### 1.5 Stop

```powershell
cd E:\daytona
docker compose -f docker/docker-compose.yaml down
```

---

## 2. Configure OpenCode

### 2.1 Plugins

File: `%USERPROFILE%\.config\opencode\opencode.json`

**Official Daytona only:**

```json
{
  "plugin": [
    "opencode-dotenv",
    "@daytona/opencode"
  ]
}
```

**With Sandbox Broker (this project):**

```json
{
  "plugin": [
    "opencode-dotenv",
    "@sandbox-dev/opencode-plugin"
  ]
}
```

See [config/opencode.example.json](../config/opencode.example.json).

### 2.2 Environment variables

File: `%USERPROFILE%\.config\opencode\daytona\.env`

```env
DAYTONA_API_URL=http://localhost:3000/api
DAYTONA_API_KEY=<local-api-key>
DAYTONA_TARGET=us
```

Loaded via `dotenv.jsonc`:

```jsonc
{
  "files": ["C:/Users/<you>/.config/opencode/daytona/.env"]
}
```

### 2.3 Windows user env (recommended)

`@daytona/opencode` reads `DAYTONA_API_KEY` at module load; dotenv alone may race. Set user-level env vars and **restart the terminal / Cursor**:

```powershell
[Environment]::SetEnvironmentVariable('DAYTONA_API_URL', 'http://localhost:3000/api', 'User')
[Environment]::SetEnvironmentVariable('DAYTONA_API_KEY', '<local-api-key>', 'User')
[Environment]::SetEnvironmentVariable('DAYTONA_TARGET', 'us', 'User')
```

### 2.4 Broker client env

```env
DAYTONA_BROKER_URL=http://localhost:8080
OPENCODE_USER_ID=alice
DAYTONA_BROKER_MODE=exclusive
```

Modes: `exclusive` | `user_shared` | `multi_user_shared` — see [docs/TESTING.md](TESTING.md).

---

## 3. Verify OpenCode

### 3.1 Use a small project directory

Avoid starting OpenCode in `C:\Users\<you>` (slow scan / black screen):

```powershell
cd E:\opencode-test
git init
opencode
```

### 3.2 Sandbox connectivity

In chat, run `pwd`:

| Output | Meaning |
|--------|---------|
| `/home/daytona/project` | Sandbox OK |
| Local `E:\...` path | Plugin or API key issue |

### 3.3 Non-interactive test

```powershell
opencode run "run pwd only"
```

### 3.4 Pure mode (plugin isolation)

```powershell
opencode run --pure "hello"
```

---

## 4. Sandbox Broker (this repo)

Full docs: [README.md](../README.md), tests: [docs/TESTING.md](TESTING.md).

### 4.1 Start Broker stack

```powershell
cd E:\sandbox-dev
npm install
npm run build

cd deploy\local
copy .env.example .env
# Edit .env: DAYTONA_API_KEY, optionally DAYTONA_SNAPSHOT=sandbox-dev-multi-user

docker compose up -d
Invoke-RestMethod http://localhost:8080/health
```

**Alternative (Node on host, Redis/Kafka in Docker):**

```powershell
cd E:\sandbox-dev\packages\broker
$env:REDIS_URL='redis://localhost:6379'
$env:KAFKA_BROKERS='localhost:9092'
$env:DAYTONA_API_URL='http://localhost:3000/api'
$env:DAYTONA_API_KEY='<key>'
$env:DAYTONA_SNAPSHOT='sandbox-dev-multi-user'
$env:MAX_SANDBOX_CONCURRENCY='2'
node dist/index.js
```

### 4.2 Run tests

```powershell
cd E:\sandbox-dev
docker exec local-redis-1 redis-cli FLUSHALL
.\scripts\run-all-tests.ps1
```

### 4.3 Multi-user snapshot (scenario 3)

```powershell
.\scripts\register-multi-user-snapshot.ps1 -Tag 0.1.1
# Register in Dashboard → Snapshots → active
```

---

## 5. Debugging

### 5.1 Log locations

| Log | Path |
|-----|------|
| OpenCode | `%USERPROFILE%\.local\share\opencode\log\opencode.log` |
| Daytona plugin | `%USERPROFILE%\.local\share\opencode\log\daytona.log` |
| Broker plugin | `%USERPROFILE%\.local\share\opencode\log\daytona-broker.log` |

```powershell
Get-Content "$env:USERPROFILE\.local\share\opencode\log\daytona.log" -Wait -Tail 30
```

### 5.2 OpenCode debug commands

```powershell
opencode debug config
opencode debug paths
opencode debug startup
opencode --print-logs run "test"
```

### 5.3 Daytona side

```powershell
docker logs daytona-api-1 --tail 50
docker logs daytona-runner-1 --tail 50
docker exec daytona-db-1 psql -U user -d daytona -c 'SELECT name, state FROM snapshot;'
```

### 5.4 SDK smoke test (bypass OpenCode)

```powershell
$env:DAYTONA_API_URL = 'http://localhost:3000/api'
$env:DAYTONA_API_KEY = '<key>'
cd E:\sandbox-dev
node -e "import {Daytona} from '@daytona/sdk'; const d=new Daytona({apiKey:process.env.DAYTONA_API_KEY,apiUrl:process.env.DAYTONA_API_URL}); const s=await d.create({snapshot:'daytonaio/sandbox:0.5.0-slim'}); console.log(await s.process.executeCommand('pwd')); await s.delete();"
```

### 5.5 Log keywords

| Message | Meaning |
|---------|---------|
| `Sandbox created successfully` | OK |
| `Invalid credentials` | Wrong key or cloud URL |
| `ECONNREFUSED` / `ENOTFOUND proxy.localhost` | Toolbox proxy URL — see [Known issues](#6-known-issues) |
| `git: command not found` | slim snapshot — sync disabled or use full snapshot |

---

## 6. Known issues

> Windows **沙箱能力**（pywin32、宿主浏览器直连端口、GUI 等）的完整边界见  
> [WINDOWS-CAPABILITY-BOUNDARIES.md](WINDOWS-CAPABILITY-BOUNDARIES.md)。下文仅列本机联调常见故障。

### Toolbox: `proxy.localhost` on Windows

**Fix** in `E:\daytona\docker\docker-compose.yaml`:

```yaml
- PROXY_TOOLBOX_BASE_URL=http://127.0.0.1:4000
```

Update DB region if needed:

```sql
UPDATE region SET "toolboxProxyUrl" = 'http://127.0.0.1:4000' WHERE id = 'us';
```

Then recreate API and flush Redis:

```powershell
docker compose -f E:\daytona\docker\docker-compose.yaml up -d --force-recreate api
docker exec daytona-redis-1 redis-cli FLUSHALL
```

### OpenCode black screen / slow start

- Start in a **small project directory**, not user home
- Fix broken plugins in `opencode.json`
- Verify Daytona env vars and restart Cursor

### `git: command not found` in sandbox

Default `0.5.0-slim` has no git. Command execution still works; git sync does not. Use full `0.5.0` snapshot if sync is required.

### Docker pull failures

See [Network & proxy](#network--proxy-clash--docker-hub). Use cached images or enable proxy temporarily.

### Organization quota 0

```sql
UPDATE organization
SET max_cpu_per_sandbox = 4,
    max_memory_per_sandbox = 8,
    max_disk_per_sandbox = 10
WHERE name = 'Personal';
```

### Scenario 3: `runuser` does not work in Docker

Docker strips setuid bits. This project uses **passwordless sudo** to `ocuser_*` accounts (`snapshots/Dockerfile.multi-user` v0.1.1).

---

## 7. Reference paths

| Purpose | Path |
|---------|------|
| Daytona deploy | `E:\daytona` |
| This repo | `E:\sandbox-dev` |
| OpenCode config | `%USERPROFILE%\.config\opencode\opencode.json` |
| Daytona env | `%USERPROFILE%\.config\opencode\daytona\.env` |
| Test project | `E:\opencode-test` |

---

## 8. Quick checklist

Before starting OpenCode:

- [ ] Docker Desktop running
- [ ] `http://localhost:3000/api/health` → ok
- [ ] (Broker) `http://localhost:8080/health` → ok
- [ ] `daytona/.env` has local API key + URL
- [ ] Terminal / Cursor restarted after env changes
- [ ] Running from a **project directory** with `git init`
- [ ] `pwd` in chat → `/home/daytona/project`

---

## Related docs

- [README.md](../README.md) — Broker overview
- [TESTING.md](TESTING.md) — test scripts, results, resource estimates
- [Daytona OpenCode plugin](https://www.daytona.io/docs/en/guides/opencode/opencode-plugin/)
