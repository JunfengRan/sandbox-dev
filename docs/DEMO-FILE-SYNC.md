# Demo：沙箱远程读写 + Markdown 回传主机

## 数据流

```
Web UI / Agent (沙箱内 OpenCode)
        │ 本地读写 /home/user/project/**/*.md
        ▼
Daytona sandbox disk
        │ Broker POST /v1/sandboxes/:id/exec
        ▼
scripts/demo-pull-md.mjs  (--watch 每 5s)
        ▼
E:\sandbox-dev\demo-output\   (gitignored)
```

Agent 在云端沙箱内写文件；主机通过 pull 脚本取回，**不是** bind-mount。

## 启动

```powershell
powershell -File E:\sandbox-dev\scripts\start-cloud-agent-demo.ps1
```

会启动 Daytona、Broker、demo gateway、模型注入、markdown watcher、Web UI。

## 手动命令

```powershell
# 一次性拉取
node E:\sandbox-dev\scripts\demo-pull-md.mjs

# 持续同步到 demo-output
node E:\sandbox-dev\scripts\demo-pull-md.mjs --watch

# 冒烟：沙箱写入 → 主机可见
node E:\sandbox-dev\scripts\demo-verify-rw.mjs
```

## 测试建议

1. 打开 Web UI Session，让 Agent 在项目里写一个 `.md`（例如 `demo/notes.md`）。
2. 数秒后查看 `E:\sandbox-dev\demo-output\` 是否出现同名文件。
3. 或先跑 `demo-verify-rw.mjs` 确认链路。

## 远程读写能力

| 方向 | 方式 |
| --- | --- |
| Agent 读/写沙箱文件 | OpenCode 工具（沙箱本地 FS） |
| 主机 → 沙箱 | Broker `exec`（注入脚本已用） |
| 沙箱 → 主机 | `demo-pull-md.mjs`（Broker `exec` + base64） |
