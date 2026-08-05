# AIO Sandbox Provider 设计

**日期：** 2026-08-05  
**状态：** Approved direction（用户确认：agent-infra AIO、方案 A 多容器、Hands 对齐）  
**范围：** 将 [agent-infra/sandbox](https://github.com/agent-infra/sandbox)（AIO）作为第三种 `SandboxProvider`，集成与部署测试方式对齐现有 `e2b` / `daytona`。

---

## 1. 目标与非目标

### 目标

1. `SANDBOX_PROVIDER=aio` 时，Broker 通过 `SandboxProvider` 管理 AIO 沙箱生命周期。
2. 按租约 **一租约一 Docker 容器**（仿 e2b）：runtime 用 `docker.sock` 拉起 `ghcr.io/agent-infra/sandbox`（或派生镜像）。
3. Hands 一等能力：`exec`（shell）+ 文件读写；跑通场景 1/2/3 测试脚本。
4. 本地 compose 可部署；`run-all-tests.ps1 -Provider aio` 可验收。

### 非目标（首版）

- 不把 Browser / VNC / VSCode / Jupyter / MCP 接到 OpenCode 插件或 Broker API。
- 不引入 AIO Cloud；仅自托管 Docker。
- 不替换 e2b / daytona；三者并存。

---

## 2. 架构

```
OpenCode / Agent (Brain)
    │  @sandbox-dev/opencode-plugin
    ▼
Sandbox Broker (:8080) ── Redis + Kafka
    │  SANDBOX_PROVIDER=aio → AioSandboxProvider
    ▼
sandbox-runtime (:8090)   RUNTIME_BACKEND=aio|e2b
    │  docker.sock
    ▼
AIO 容器（每租约一个）
    容器内服务 :8080
    /v1/shell/exec  /v1/file/read|write  /v1/sandbox
```

| 层 | 职责 |
|----|------|
| Broker `AioSandboxProvider` | 实现 `SandboxProvider`；HTTP 调 runtime `/v1/sandboxes/*`（与 e2b 同形） |
| sandbox-runtime（aio 后端） | create/start/stop/delete/resize；exec/files **经 AIO HTTP**，非 `docker exec` |
| AIO 容器 | 官方/派生镜像；保留原 entrypoint；Hands 只用 shell/file API |

插件侧：复用与 e2b 相同的 runtime handle（Broker 已授予 `sandboxId` 后，工具经 runtime 执行）。工作目录默认 `/home/gem/workspace`。

---

## 3. 生命周期与网络

### create

1. 生成 `sbx_*` id；`docker create` AIO 镜像（**不**覆盖为 `sleep infinity`）。
2. HostConfig：`NanoCpus` / `Memory`；`SecurityOpt: ["seccomp=unconfined"]`；`ShmSize: 2gb`（与官方 compose 对齐）。
3. 加入与 runtime 相同的 Docker 网络（新建或使用 `sandbox-dev-aio`），便于 runtime 用容器 IP:8080 访问。
4. Labels：`sandbox-dev.managed=true`、`sandbox-dev.sandbox-id`、`sandbox-dev.backend=aio`。
5. start 后轮询 `GET http://<ip>:8080/v1/sandbox`（或 `/health` 若存在）直至就绪，超时失败则 delete 并报错。
6. Record 增加 `endpoint`（`http://<ip>:8080`）与 `backend: 'aio'`。

### exec / files

- `POST {endpoint}/v1/shell/exec`，body：`{ command, env? }`；若需 cwd：将 command 包成 `cd <cwd> && <command>`（或等价）。
- 归一化响应为 `{ exitCode, stdout, stderr }`（AIO 常见为 `data.output` / `data.exit_code`）。
- 文件：优先 `POST /v1/file/read`、`/v1/file/write`；若字段名与文档不一致，以 OpenAPI `/v1/docs` 为准做适配层。
- 可选：`X-AIO-API-Key`（env `AIO_API_KEY`），无 key 时保持官方「开放」兼容。

### stop / start / delete / resize

- 与现有 Docker 管理一致：stop/start 容器；delete force remove；resize 用 `container.update`（与 e2b 相同限制）。

### e2b 兼容

- `RUNTIME_BACKEND=e2b`（默认）时行为不变：`docker exec` + 当前镜像。
- 同一 runtime 进程按 **sandbox record 的 backend** 分流，避免混跑时误用错误 exec 路径。Broker 在 `SANDBOX_PROVIDER=aio` 时创建请求可带 `backend: aio` 或依赖 runtime 全局 `RUNTIME_BACKEND=aio`。

**首版约定：** local compose 在 `SANDBOX_PROVIDER=aio` 时设 `RUNTIME_BACKEND=aio`；不做单 runtime 内 e2b/aio 混创建（简化）。

---

## 4. 配置

| 变量 | 默认 | 说明 |
|------|------|------|
| `SANDBOX_PROVIDER` | — | 新增取值 `aio` |
| `RUNTIME_BACKEND` | `e2b` | runtime：`e2b` \| `aio` |
| `AIO_IMAGE` | `ghcr.io/agent-infra/sandbox:1.11.0` | 可换国内 mirror |
| `AIO_WORK_DIR` | `/home/gem/workspace` | `PROJECT_BASE_PATH.aio` |
| `AIO_API_KEY` | 空 | 可选 |
| `AIO_READY_TIMEOUT_MS` | `120000` | 就绪等待 |
| `SANDBOX_CPU` / `SANDBOX_MEMORY_MIB` | aio 建议 `1` / `2048` | AIO 镜像更重 |
| `E2B_RUNTIME_URL` | 不变 | Broker→runtime；aio 复用同一 URL 字段或别名 `AIO_RUNTIME_URL`（同值） |

`SandboxProviderName`：`'daytona' | 'e2b' | 'aio'`。  
`PROJECT_BASE_PATH.aio = '/home/gem/workspace'`。

---

## 5. 场景与镜像策略

| 场景 | 模式 | aio 策略 |
|------|------|----------|
| 1 | exclusive | 官方/派生 AIO 镜像即可 |
| 2 | user_shared | 同 sandbox，目录 `{base}/sessions/{sessionId}` |
| 3 | multi_user_shared | **派生镜像** `sandbox-dev/aio-runtime:0.1.0`：`FROM` AIO，创建 `ocuser_001..032`，给主用户（`gem`）passwordless `sudo -u ocuser_*`；保留 AIO ENTRYPOINT |

场景 3 隔离仍走现有 `asLinuxUser` + `hashUserToLinuxUser`；exec 命令内 `sudo -u ocuser_XXX ...`。若官方用户名不是 `gem`，以 `/v1/sandbox` context 为准写入 Dockerfile。

---

## 6. 代码改动面（摘要）

| 路径 | 变更 |
|------|------|
| `packages/shared` | `SandboxProviderName` + `PROJECT_BASE_PATH.aio` |
| `packages/sandbox-runtime` | aio create/ready/exec/files；`RUNTIME_BACKEND` |
| `packages/broker` | `AioSandboxProvider`、config、factory |
| `packages/opencode-plugin` | provider 解析、默认 workDir |
| `snapshots/Dockerfile.aio-runtime` | 派生多用户 AIO 镜像 |
| `deploy/local` (+ server) | env / 可选 backend |
| `scripts/*` | `-Provider aio`；exec 走 runtime |
| `README.md` / `docs/TESTING.md` | 文档与验收结果位 |

---

## 7. 错误处理

- 镜像拉取失败：create 返回 5xx，信息含 pull 错误。
- 就绪超时：清理容器，返回明确 timeout 错误。
- AIO HTTP 非 2xx：映射为 exec/files 失败，body 截断写入 stderr/message。
- 容器已停：exec 前尝试 start（与 e2b 一致）。

---

## 8. 测试与验收

1. 构建/拉取：`Dockerfile.aio-runtime` 或 pin 官方镜像。  
2. `deploy/local`：`SANDBOX_PROVIDER=aio`、`RUNTIME_BACKEND=aio`，`docker compose up -d --build`。  
3. health：Broker `:8080`、runtime `:8090`。  
4. `.\scripts\run-all-tests.ps1 -Provider aio` → 场景 1/2/3 API + 场景 3 OS 隔离。  
5. 记录结果到 `docs/TESTING.md`（日期与资源备注）。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| AIO 镜像大、启动慢 | 拉高 ready timeout；默认 1 CPU / 2 GiB；文档说明首次 pull |
| Windows Docker 网络 | runtime 与 sandbox 同自定义 network；用 inspect IP |
| API 字段漂移 | 单文件 `aio-client.ts` 适配；对照 OpenAPI |
| 场景 3 与 AIO 用户模型冲突 | 派生镜像明确 sudoers；失败则文档标 FAIL 原因 |

---

## 10. 决策记录

- 产品：agent-infra AIO（用户确认）。  
- 部署：按租约 docker 多实例（方案 A）。  
- 首版能力：Hands shell/file + 三场景（方案 A）。  
- 实现：扩展 `sandbox-runtime`，不新建独立 aio-runtime 包。  
- 场景 3：派生多用户镜像，不削弱官方 AIO entrypoint。
