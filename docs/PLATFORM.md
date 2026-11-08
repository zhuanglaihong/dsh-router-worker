# 三平台验证边界（Windows / macOS / Linux）

> 本文如实说明 `dsh-subagent-tree` 在三个操作系统上的**验证到哪一层、哪一层没验**。
> 结论先行：**macOS 真机已验；Windows / Linux 通过 CI 代码层验证（语法 + 单测 + 打包），
> GUI 与 ACL 冒烟待真机**。请勿把「CI 绿」当作「Windows 能跑 GUI / ACL」。

本机开发环境**仅有 macOS**，无 docker / podman / gh。因此 Electron-GUI 级别与 Windows
ACL 级别的验证，必须借助用户提供的**真实 Windows / Linux 机器**完成，CI 无法替代。

---

## 四层验证边界

| 层 | 文件 | 状态 | 说明 |
| --- | --- | --- | --- |
| ① 纯逻辑层 | `lib/store.js`、`lib/outbox.js`、`lib/dispatcher.js`、`lib/watchdog.js`、`lib/platform.js` | ✅ 自动跨平台 | 纯 JS + `path.join` + 平台参数注入，不碰 OS API。由 CI 三平台矩阵 + `node:test` 单测覆盖。 |
| ② 客户端 UI 层 | `lib/client.js` | ✅ 基本自动跨平台 | Electron 吸收了绝大多数 OS 差异；CSS 走 `--dsw-alias-*` 令牌，不写死平台样式。**注意**：这层是「差异少」，不等于「在 Windows/Linux 真机看过」。 |
| ③ 三处显式平台分支 | `presets/router-worker/workspace-acl.mjs`、`approval-gate.mjs`、`composition.mjs` | ⚠️ 有适配、未真机验证 | 这三份是从 upstream MIT 项目**逐字复制**的，为保持 upstream diff 干净而**刻意不改**。写了 Windows 适配，但**从未在 Windows / Linux 真机执行过**。 |
| ④ 打包 / 安装 / Electron GUI 冒烟 | 整个插件 | ❌ 必须真机 | CI runner 无显示环境、无真实 Electron 会话、无法复现 Win32 安全描述符；本机又仅 macOS。 |

### 关于第 ③ 层：为什么单靠 CI 不够，以及 `lib/platform.js` 的作用

三份预设里的分支是内联的 `process.platform === 'win32'` 判断：

- `workspace-acl.mjs:185` `const IS_WINDOWS = process.platform === 'win32'`、
  `:690` `if (!IS_WINDOWS) return`，以及大量 `\\` / `.toLowerCase()` 路径归一化。
- `approval-gate.mjs:507` 路径归一化表达式、`:588/:599` `process.platform === 'win32'`、
  `:1020` `const caseInsensitive = process.platform === 'win32'`（工作区前缀大小写比较）、
  `%LOCALAPPDATA%\Temp` 临时根提示。
- `composition.mjs:1119` `disabled: process.platform === 'win32'`（bash 工具）、
  `:1124` `disabled: process.platform !== 'win32'`（pwsh 工具）。

`lib/platform.js` 把这些内联判断**镜像成纯函数**：所有函数都把 OS 当作显式参数
（`'win32' | 'darwin' | 'linux'`）传入，模块内部不读 `process.platform`。于是在 macOS
开发机、以及 ubuntu / macos 的 CI runner 上，也能确定性地演练 Windows 路径大小写比较、
pwsh/bash 开关等分支语义。`test/platform.test.mjs` 为此覆盖三平台共 20 个用例。

**但这是「分支语义正确」的证明，不是「真机能跑」的证明。** 纯函数能验证逻辑，验证不了
Win32 安全描述符 API、文件系统 ACL、Electron 窗口与子进程行为。

> ⚠️ **最大风险点**：`workspace-acl.mjs` 的 Windows ACL / 安全描述符代码。macOS 上
> **无法复现** `SetNamedSecurityInfoW failed (Win32 5)`（拒绝访问）这类错误——该 API
> 根本不存在于非 Windows 系统。这段在 CI 里只能做**语法检查**，运行时行为必须真机验证。

---

## CI 做了什么、没做什么

`.github/workflows/ci.yml`（name `CI (three platforms)`）在
`ubuntu-latest / windows-latest / macos-latest` × Node `24` 矩阵上执行三步：

1. **Syntax check**：一个 `node -e` 内联脚本遍历 `lib/*.js|*.mjs` 与
   `presets/router-worker/*.mjs`，逐个 `node --check`。用 Node 写 walker 而非 shell glob，
   是为了同一条命令在 bash（ubuntu/macos）与 pwsh（windows 默认 shell）上都能跑。
2. **Unit tests**：`node --test test/watchdog.test.mjs test/platform.test.mjs`——显式列文件，
   避开 pwsh 与 bash 对 `test/*.test.mjs` glob 展开行为的差异。
3. **Pack**：`npm pack --dry-run`，打印将进入 tarball 的文件清单（由 `package.json` 的
   `files` 字段决定），确认打包内容。零运行时依赖，无需 pnpm。

> Job 级已注明：**Electron GUI 冒烟测试无法在 CI 运行**（无显示环境 / 无 Electron 会话 /
> 无法复现 Win32 ACL），必须在真实 Windows 与 Linux 机器上完成。

CI 覆盖面：语法、纯逻辑单测、三平台可模拟性、打包清单。CI 不覆盖：真机安装、GUI、
ACL 安全描述符、pwsh/bash 工具的真实启用与执行、子代理真实写文件。

---

## Node 版本说明

- `package.json` 声明 `engines.node >= 24`。
- `lib/store.js` 使用 `node:sqlite`（Node 22+ 实验、24 起稳定）。
- 代码对 `node:sqlite` 有 `try/catch` 降级：在 Node < 24 上会回退到**内存表**——
  **不会崩溃，但不落库**（进程重启数据即失）。这不是「完全可用」，请勿据此宣称支持旧版。

---

## 发布口径（请如实引用，勿夸大）

> **macOS 真机已验；Windows / Linux 通过 CI 代码层验证（语法 + 单测 + 打包），
> GUI 与 ACL 冒烟待真机。**

含义：Windows / Linux 目前只验证了「代码层」——语法无误、纯逻辑单测通过、tarball 内容正确。
**尚未**在真机安装、看过 GUI、跑过 Windows ACL 或确认子代理能写文件。要升级口径，
必须先完成下面的真机冒烟清单。

---

## 真机冒烟清单（给用户）

请在 **Windows** 和 **Linux** 上**各装一次**，按下列步骤走一遍：

1. 在该平台安装插件（走真实安装 / Electron 启动流程，而非仅 `npm pack`）。
2. 新建会话，选择 **「Router 项目经理模式」**。
3. 派一张**写文件**的工单给子代理（让主会话只拆任务、读写下放）。
4. 逐项确认：
   - [ ] **不出现** `SetNamedSecurityInfoW failed (Win32 5)`（Windows ACL / 安全描述符正常）；
   - [ ] **pwsh / bash 工具按平台正确启用**：Windows 启用 pwsh、禁用 bash；Linux 反之
         （对应 `composition.mjs:1119/1124`）；
   - [ ] **子代理能写文件**（工作区 ACL / 路径前缀比较在真机上放行正确）；
   - [ ] **侧栏树显示短名**（子代理子树缩进、短名、状态、折叠正常）。
5. 任一平台四项全过，才可把发布口径升级为「Windows / Linux 真机已验」。

> 提示：第 4 项第 1 条（ACL）是 Windows 专属风险，macOS 永远替不了；请务必在**真实
> Windows 机器**上执行，不要只在 Linux 上跑完就宣称 Windows 通过。
