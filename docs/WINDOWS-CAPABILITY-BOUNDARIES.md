# Windows 操作能力边界

本文说明：**本仓库沙箱能做什么、对 Windows 原生能力明确做不到什么**。  
评审基线：2026-07-25；运行时为 **Linux Docker 容器**（`daytona` / `e2b`），不是 Windows VM / Windows 容器。

> 一句话：**Windows 上可跑 Agent（Brain）；工具与进程在远端 Linux Hands 里执行。**  
> 客户端无需 WSL，但也不要期望沙箱内具备 Windows API、桌面、注册表或本机端口直连。

---

## 1. 架构前提（先看这个）

```
Windows / macOS / Linux 客户端
    │  OpenCode / Agent（本地）
    ▼
Sandbox Broker
    ▼
Linux 容器沙箱（Daytona Runner 或 sandbox-runtime → Docker）
    · 默认镜像：基于 daytonaio/sandbox 系 Linux snapshot
    · E2B 路径：无 PortBindings / 无自动端口发布
    · 工具面：bash / 文件读写改 / glob / grep（见 opencode-plugin）
```

| 维度 | 本仓库现状 |
|------|------------|
| 沙箱 OS | **Linux**（容器），非 Windows |
| 隔离级别 | 容器级（非 Firecracker microVM；真 microVM 需 Linux+KVM） |
| Windows 客户端 | 支持：Agent 本地，命令远端执行 |
| Windows **沙箱** | **不提供**（Daytona Cloud 的 Windows VM / Computer Use 未接入本 Broker） |
| 一等工具 | `bash`、`read`、`write`、`edit`、`glob`、`grep` |
| 端口预览 / 转发 API | **未实现**（Broker / sandbox-runtime 无 preview、无 forward） |

官方 Daytona 另有 **Windows VM sandbox** 与 **Computer Use**（鼠标/键盘/截图等），属于另一条产品能力线；**本仓库 Hands 路径未接入**，下文「不可用」均指本仓当前实现。

---

## 2. 能力矩阵（速查）

| 类别 | 状态 | 说明 |
|------|------|------|
| Linux shell / 跨平台 CLI | ✅ | `bash -lc` 等 |
| 沙箱内读写文件 | ✅ | 插件 `read`/`write`/`edit` |
| 出站网络（拉包、调 API） | ✅* | 取决于 Docker/代理/防火墙；非本仓保证 |
| Windows 宿主浏览器直连沙箱端口 | ❌ | 需转发 / 发布；本仓未封装 |
| pywin32 / Win32 / COM / WMI | ❌ | Linux 无 Win32 |
| Windows GUI / UIA / 键鼠注入 | ❌ | 无 Windows 桌面会话 |
| 注册表 / 服务控制管理器 | ❌ | |
| RDP / 交互式 Windows 桌面 | ❌ | |
| 挂载本机 `C:\` 当沙箱盘符 | ❌ | 路径与语义均为 Linux |
| Firecracker 自托管（Windows Docker Desktop） | ❌ | 需 Linux + KVM |
| Daytona Computer Use / Windows VM | ⛔ 未接入 | 官方能力 ≠ 本仓能力 |

\*出站是否通畅受本机 Clash、Docker Desktop 代理、公司网络影响，见 [local-daytona-setup](local-daytona-setup.md)。

---

## 3. Windows 原生 API 与自动化（不可用）

沙箱内是 Linux 用户态，下列依赖 **无法** 在沙箱中直接使用（安装也会失败或仅能装到无意义的 stub）：

### 3.1 Python / .NET / 脚本生态

| 能力 | 典型库 / 机制 | 原因 |
|------|----------------|------|
| Win32 API 封装 | `pywin32`、`win32api`、`win32gui`、`win32process` | 无 Windows API |
| COM / OLE 自动化 | `win32com`、Excel/Outlook/Word COM、`pythonnet`+Windows CLR | 无 COM 运行时 |
| WMI | `wmi`（依赖 pywin32） | 无 WMI |
| 注册表 | `winreg`、`RegOpenKey*` | 无注册表 |
| UI 自动化 | `pywinauto`、UI Automation、`uiautomation` | 需 Windows 交互桌面 |
| 键鼠 / 截屏（Windows） | `pyautogui`（Win 后端）、`mss` 抓宿主屏 | 无该桌面；也非本仓 Computer Use |
| Windows 服务 | `pywin32` service、`sc.exe`、SCM | 无 SCM |
| DPAPI / Credential Manager | `win32crypt`、Windows Vault | 无 |
| 命名管道（Windows 语义） | `\\.\pipe\...` | 仅有 Linux socket/FIFO |
| PowerShell Windows 专用 | `Get-Service`、`New-Object -ComObject`、AD cmdlet 等 | 即便装了 `pwsh`，也无 Windows 后端 |
| WinForms / WPF / WinUI | .NET Windows 桌面栈 | 非该 OS |
| MSI / ClickOnce / Store 应用 | Windows Installer 生态 | 不可用 |

### 3.2 系统与安全

- Active Directory 域成员、NTLM/Kerberos **作为 Windows 域客户端**的本机集成  
- BitLocker、Windows Defender API、AppLocker 策略操作  
- 驱动、内核模式、Hyper-V 管理（在沙箱内）  
- 打印机、USB、智能卡、本机音频设备直通  

### 3.3 「在沙箱里测 Windows 安装包 / 桌面程序」

不可行。需要 **真实 Windows 机、Windows VM，或官方 Windows sandbox 产品线**；本 Broker 的 Hands 不能替代。

---

## 4. GUI、浏览器与「看见界面」

| 场景 | 本仓 | 备注 |
|------|------|------|
| 自动化 Windows 桌面应用 | ❌ | 无 Windows GUI |
| 官方 Daytona Computer Use（键鼠/截图/录屏） | ⛔ 未接入 | 即便 Daytona 支持，本 Broker/插件未暴露 |
| 沙箱内无头浏览器（Chromium + Playwright，若镜像已装） | ⚠️  theoretically 可能 | 默认 slim/业务镜像 **不保证** 已装浏览器；需自备依赖与 display（如 Xvfb） |
| Windows **宿主** Chrome 打开 `http://localhost:<沙箱端口>` | ❌ 默认不通 | 见下一节端口 |
| 抓取 Windows 宿主屏幕 / 剪贴板 | ❌ | Agent 工具面不操作宿主桌面 |

结论：本 Hands 面向 **CLI + 文件系统 +（可选）无头服务**，不是 Windows RPA / Computer Use 产品。

---

## 5. 网络与端口（高频踩坑）

### 5.1 两个「localhost」不是同一个

| 位置 | `127.0.0.1` / `localhost` 含义 |
|------|--------------------------------|
| Windows 宿主浏览器 / IDE | 指向 **Windows 本机** |
| 沙箱内进程 | 指向 **该 Linux 容器内部** |

因此：在沙箱里 `npm run dev` 监听 `0.0.0.0:3000` 或 `127.0.0.1:3000`，**宿主浏览器默认打不开**，除非做了端口发布或转发。

### 5.2 本仓实现现状

- **E2B-compatible `DockerSandboxManager`**：创建容器时 **未设置** `PortBindings` / `ExposedPorts` / publish，容器端口不对宿主暴露。  
- **Broker API**：无 `preview`、无 `forwardPort`、无「打开预览 URL」一等接口。  
- **OpenCode 插件**：工具集无端口转发工具。

### 5.3 若必须从 Windows 浏览器访问沙箱服务

需在仓外自行处理，例如（任选其一，**非本仓保证**）：

1. **Daytona**：使用其 preview / proxy / `daytona forward` 等官方能力（需自行对接 SDK，本 Broker 未封装）。  
2. **Docker**：对已创建的 sandbox 容器手动 `docker port` / 重建时加 `-p`（与当前 runtime 创建路径不一致，易被生命周期覆盖）。  
3. **SSH / 反向隧道 / 第三方 tunnel**（ngrok、cloudflared 等）——在沙箱网络策略允许时。  
4. **仅容器内自测**：用 `curl`/`wget` 在 `bash` 工具里访问，不经过宿主浏览器。

### 5.4 其他网络边界

| 项 | 说明 |
|----|------|
| 入站从公网直达沙箱 | 默认无；需显式代理/预览 |
| 沙箱访问宿主上的服务 | 视 Docker Desktop 网络而定（常见需 `host.docker.internal`，且非本仓文档化保证） |
| UDP / 原始套接字 / 混杂模式 | 容器能力受限，勿假设与物理机对等 |
| IPv6、多播、本地 mDNS | 行为依赖 Docker Desktop，不可靠 |
| Windows 命名管道连宿主 | 不可用 |

Windows 本机联调时另见：Daytona Toolbox **`proxy.localhost` 解析失败**、Clash 与 Docker Hub / IDE 冲突 —— [local-daytona-setup § Known issues](local-daytona-setup.md#6-known-issues)。

---

## 6. 文件系统与路径语义

| Windows 习惯 | 沙箱实际 |
|--------------|----------|
| `C:\Users\...`、盘符 | 仅 Linux 路径（如 `/home/user/project`） |
| 大小写不敏感 | 多为大小写敏感 |
| NTFS ACL / ADS | 无；为 Linux 权限（uid/gid、mode） |
| 文件锁 / 强制删除占用中的 exe | 语义不同；无 Windows 文件锁模型 |
| 把整个 Windows 工程目录当「同一磁盘」原地改 | Agent 在本地、工具在远端时，需同步/工作副本；**不是**直接改你本机盘 |
| CRLF 为主 | 容器内常为 LF；跨端编辑可能产生行尾差异 |

场景 2/3 的目录 / `ocuser_*` 隔离均为 **Linux 语义**，见 README 与 [TESTING](TESTING.md)。

---

## 7. Windows 宿主上跑本仓库（环境边界）

这些不是「沙箱内 Windows API」，而是 **在 Windows 上部署 Hands** 时的限制：

| 项 | 边界 |
|----|------|
| Docker Desktop | 通常需 **WSL2 backend**；资源与虚拟化需在 BIOS/Windows 功能中开启 |
| 真 Firecracker / 官方 E2B infra | **不能**作为本仓默认路径（需 Linux + KVM） |
| 镜像拉取 | 易与本机 HTTP 代理（Clash 等）打架；见 setup 文档 |
| Daytona `proxy.localhost` | Windows 上常需改为 `127.0.0.1:4000` |
| nested 虚拟化 / GPU 直通到沙箱 | 非本仓范围；默认不可用 |
| `docker.sock` | 经 Docker Desktop 暴露给 compose 中的 runtime；权限与重启行为随 Desktop |

---

## 8. 建议用法 vs 明确改走别路

### 适合本沙箱

- 跨平台语言：Python/Node/Go 等 **不依赖 Win32** 的代码  
- CLI 构建、单测、lint、在 Linux 上跑服务并用 **容器内** curl 验证  
- 需要隔离执行、并发租约、多 session 目录隔离的 Agent Hands  

### 应改用 Windows 本机或 Windows VM

- 任何 `import win32*` / COM / 注册表 / Windows 服务  
- 桌面 RPA、Office 自动化、安装包 UI 测试  
- 「用本机浏览器打开沙箱里起的端口」且不愿自建转发  
- 必须验证 NTFS / AD / 企业 Windows 策略  

### 与官方 Daytona Windows / Computer Use 的关系

若业务需要 Windows OS 或键鼠截图自动化：评估 **Daytona Windows VM / Computer Use**（或其他 Windows 执行面），再单独做 provider——**不要假定打开本仓库 Broker 即具备这些能力**。

---

## 9. 与「已知限制」的关系

仓库级通用限制（容器非 microVM、场景 3 碰撞、`IdlePolicy: pool`、无 Firecracker 等）见 [README § 已知限制](../README.md#已知限制)。  
本文只展开 **Windows 操作 / 宿主联调 / 端口与 GUI** 边界；产品演进见 [FUTURE-WORK](FUTURE-WORK.md)。

---

## 10. 参考

- [README.md](../README.md) — 架构与 provider  
- [local-daytona-setup.md](local-daytona-setup.md) — Windows 本机 Daytona、代理、`proxy.localhost`  
- [Daytona Sandboxes](https://www.daytona.io/docs/en/sandboxes/) — 含 Windows VM 规格（官方；非本仓默认）  
- [Daytona Computer Use](https://www.daytona.io/docs/en/computer-use/) — GUI 自动化（官方；本仓未接入）  
- pywin32 仅面向 Windows API：[pywin32#1372](https://github.com/mhammond/pywin32/issues/1372)  
