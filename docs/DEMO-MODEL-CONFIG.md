# Demo：DeepSeek V4 Flash + Agent 配置

## 设置途径（不要提交 API Key）

| 文件 | 是否可提交 | 作用 |
| --- | --- | --- |
| `deploy/local/opencode.demo.json` | 是 | 模型/agent 模板；仓库内用 `{file:...}` 占位。注入脚本会把真实 key 写入**沙箱内** `opencode.json`（不回写仓库） |
| `deploy/local/.env.demo.secrets.example` | 是 | secrets 示例 |
| `deploy/local/.env.demo.secrets` | **否（gitignore）** | 本地 `DEEPSEEK_API_KEY=...` |
| 本机 `~/.config/opencode/opencode.json` | 否（用户目录） | 注入脚本可回退读取其中的 deepseek key |

默认模型：`deepseek/deepseek-v4-flash`  
Agent：复用 OpenCode 内置 `build` / `plan`（与本地配置一致的 `store: false`）。

## 对已运行的 demo 沙箱注入

先保证 `demo-web-gateway.mjs` 已有 active lease，然后：

```bash
# 可选：手动准备 secrets
copy deploy\local\.env.demo.secrets.example deploy\local\.env.demo.secrets
# 编辑填入 DEEPSEEK_API_KEY

node scripts/demo-inject-model-config.mjs
```

未准备 `.env.demo.secrets` 时，脚本会尝试从本机 `~/.config/opencode/opencode.json` 读取 deepseek key，并写入 gitignored 的 `.env.demo.secrets`。

注入后：

1. 打开 Web UI：`http://localhost:5173`
2. 进入已有 Session（或新建）
3. 底部 **Select model** → **DeepSeek / DeepSeek V4 Flash**
4. Agent 使用内置 `build` / `plan`（与本地一致）

已验证：沙箱内 `/api/provider/deepseek` 可用，Session `switchModel` 到 `deepseek/deepseek-v4-flash` 返回 204。

### UI bootstrap 相关修复（demo）

- Broker Daytona 原始代理曾误剥 `content-encoding`，导致 gzip 体被当 JSON 解析 → toast「failed to reload project」。已修复：raw `http.request` 路径保留压缩头；`fetch` 路径仍剥离。
- 沙箱镜像缺少 `/api/model/default` 时会回 HTML；demo gateway 会补 JSON，并把 `opencode.json` 里的自定义 provider/model 合并进 `/api/provider`、`/api/model`（v2 `available()` 只认 `request.body.apiKey`，否则选不中 DeepSeek）。

## 新租约自动注入（Broker）

在 Broker 环境中（可用 gitignored secrets / compose env_file）：

```env
OPENCODE_DEMO_CONFIG=true
DEEPSEEK_API_KEY=...   # 仅本地 secrets，勿提交
```

Broker 会把 `OPENCODE_CONFIG_CONTENT`（来自 `opencode.demo.json`）和 `DEEPSEEK_API_KEY` 注入沙箱内 `opencode serve`。
