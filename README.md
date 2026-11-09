# dsh-router-worker

在 DSH 的左侧会话列表里，把**子代理会话**画成主会话的**缩进子树**：连接线、编号 + 摘要、运行状态。

- 对**任意 agent 模式**生效：标准模式派的子代理、本插件自带的「Router 项目经理模式」派的子代理、你自己写的 preset 派的子代理，只要有父子关系就会出现在树里。
- 对**皮肤 / 主题结构无关**：只用宿主的业务属性 `[data-row-key^="session:"]` 作锚点，**宿主行一个字节都不动**（不塞按钮、不改 padding、不改标题 margin），箭头和状态条全部画在自己那块子树里；缩进按主题字号 `--dsw-font-size-sm` 用 `em` 算，颜色取 `--dsw-alias-*` 语义变量。原生皮肤、claude style 这种会把行包进一层 box 并重排的皮肤、以及以后换密度 / 换主题都不会让它错位（详见[兼容自定义皮肤](#兼容自定义皮肤)）。
- 不修改宿主源码，不替换任何宿主槽位，卸载即恢复原样。

---

## 它解决什么问题

DSH 标准的会话列表是**平铺**的：主会话和子代理会话混在一起，而宿主又刻意把 `origin === 'subagent'` 的会话从列表里隐藏掉（`sessionVisible()` 对子代理返回 false）。结果是：

- 你看不到主对话底下到底派了几个子代理；
- 想知道某个子代理干到哪一步，只能去右侧任务管理面板一个个点开；
- 视图一关，子代理的痕迹就从左侧消失了。

装上本插件后，主会话那一行下面会多出它的子会话，缩进一级、用连接线连起来，每行带「运行中 / 已结束」和一句摘要，点一下就能打开它的过程记录。

## 长什么样

展开：

```
  ◈ 面试复盘                            2026-11-07   18:28
    ▾ 3 条子对话
      ├ ● #1 山东云鼎问题书面化                      运行中
      ├ ● #2 途虎养车问题书面化                      已结束
      └ ● #3 Draft 山东云鼎科技 doc                  已结束
  ◈ DeepSeek 超级智能体四特点与实现              2026-11-07   17:02
    ▾ 1 条子对话
      └ ● #1 整理四特点对照表                        运行中
```

> 注意箭头**不在主行里**：`▾ 3 条子对话` 是子树块自己的第一行（一条控制行），
> 点整行都能收起 / 展开。这是「结构无关」的关键 —— 不往宿主行里塞任何东西。

子对话很多时，默认只画最近 3 条，更早的折成一行提示（再点一次就全展开）：

```
  ◈ 面试复盘                            2026-11-08   18:28
    ▾ 6 条子对话
      还有 3 条更早的子对话
      ├ ● #4 新建友塔游戏复盘                        已结束
      ├ ● #5 Draft 山东云鼎科技 doc                  已结束
      └ ● #6 整理三家公司的时间线                    已结束
```

收起（主对话之外只留那条控制行）：

```
  ◈ 面试复盘                            2026-11-07   18:28
    ▸ 3 条子对话
```

**排队中的工单也能看见**（轻量版状态条）。原来的树只读「已存在的子会话」，而一张还在排队、没派出去的工单没有子会话，会整个消失。0.2.0 起在主行下面内联一条汇总：

```
  ◈ 面试复盘                            2026-11-08   18:28
    ▾ 2 条子对话
    ● 2 运行中   ● 1 排队
    排队：梳理变更要点
      ├ ● #1 核对版本号一致性                      运行中
      └ ● #2 统计预设目录规模                      运行中
```

- 状态条是「N 运行中 / M 排队」两个小圆点 chip；**收起时也保留**，等于「一眼看汇总」。
- 排队工单逐条列一行短名，只显示 `queued|running` 的非敏感字段。
- 数据来自宿主半开的一个同源 GET 路由（`/plugins/dsh-router-worker/tickets`），2.5 秒轮询一次；失败保留旧快照不闪空白，取不到数据时状态条静默不画，子对话树照常。
- 这是**轻量版**：没有独立面板、没有「重试 / 取消」按钮，只是在现有树里补一行 —— 排队项才是真缺口。

渲染截图（在模拟宿主 DOM 的验证页里跑真实 `lib/client.js`；**每栏各画两遍**：左边原生
`list > row`、右边 claude-style `list > box > row`，用来直观确认两种结构逐像素一致）：

| 展开 | 收起（主行收起，只剩控制行） |
|---|---|
| ![expanded](docs/shots/expanded.png) | ![collapsed](docs/shots/collapsed.png) |

- **▾ / ▸** 在子树块自己的第一行（「N 条子对话」控制行），**不画在宿主主行里**。点整行收起 / 展开 —— 每个主行单独记状态（localStorage，重开应用还在）；子对话超过 3 条时只显示最近的，更早的折成「还有 N 条更早的子对话」。
- **#1 / #2** 是编号，按子会话创建时间排。
- 标题优先取宿主派单时写下的短名（`subagentCatalog[].label`，也就是主智能体给这次派活起的名字，如「山东云鼎问题书面化」），拿不到才退回会话标题，再拿不到才用会话 id 前 8 位。
- 子行缩进按**主题字号**算，不写死像素：引导线 `--sat-line = 4 × --dsw-font-size-sm`、文字 `--sat-indent = 6 × --dsw-font-size-sm`（13px 字号时分别是 52px / 78px，16px 时 64px / 96px）。换皮肤、换密度都跟着缩放。
- **●** 的颜色表示状态：运行中是品牌色，已结束是中性色；连接线用 `currentColor` 的淡色版本，任何主题下都协调。

## 兼容自定义皮肤

2026-11-08 有一个真实的反例：启用 `dsh-claude-style` 后，侧栏树整块错位 —— 主行变成一条空灰条、子行与连接线断成两截。根因**不是颜色**，而是皮肤的 DOM 结构：

`dsh-claude-style` 的 `dateGroups` 功能把每个 `[data-row-key^="session:"]` 行包进一层
`box`（`box = row.parentElement`），用 `appendChild(box)` 按日期整体搬动、用
`box.style.display="none"` 整体隐藏、在 box 之间插日期标题、还往 row 里插
`dsh-claude-date-chip`。DOM 从原生的 `list > row` 变成 `list > box > row`。

旧实现有三处假设在这套结构下全崩，也正是修复的地方：

| 旧假设 | 为什么崩 | 现在 |
|---|---|---|
| 子树用 `insertAdjacentElement("afterend")` 紧跟在 row 后 | 在 boxed 结构里子树掉进 **box 内部**，被重排逻辑当成杂项丢弃 → 父行与子行断开 | `attachHolder()` 仍紧跟 row，但要求 `holder.parentElement === row.parentElement`；`holdersAligned()` 在皮肤重建 DOM 时强制重挂。子树作为 box 的子节点，随 box 一起搬、一起藏 |
| 往主行里塞绝对定位箭头、改 `paddingInlineStart` / 标题 `marginInlineStart` | 皮肤往 row 里插 chip 后，量到的「标题左边界」不再是标题，标题被推没 | **宿主行一个字节都不动**。箭头、控制行、状态条、子行全部画在自己的子树块里 |
| CSS 写死 `left: 48px` / `padding-left: 64px` | 换主题 / 密度后行首留白不同，固定像素不再对齐 | 缩进用 `em` 与 `--dsw-font-size-sm` 计算；颜色全取 `--dsw-alias-*` |

所以「兼容其余 style」不是给每个皮肤写一套适配，而是**去掉所有对结构的假设**：

1. 只认业务属性（`data-row-key`），不认 class / 哈希 / 层级；
2. 不修改宿主行（不插子节点、不改内联样式）；
3. 子树挂在父行**所在容器**里，容器被整体搬动 / 隐藏时一起走；
4. 缩进、颜色、字号都从主题变量推导，不写死像素。

这不是口头承诺：`test/sidebar-structure.test.mjs` 用 vm 驱动**真实 `lib/client.js`**，
同时模拟原生 `list > row` 与 claude-style 的 `list > box > row` 并复现 box 重排，
断言宿主行始终干净、子树始终与父行同容器、重排后仍连着文档；
`test/platform.test.mjs` 之外还有头无显示环境的 CDP 几何验证（原生与 boxed 两种
DOM 在 13px / 16px 字号下逐像素一致）。三平台 CI 每次都会跑这些回归。

## 安装

四种方式，装完都要**完全退出（⌘Q）再重开** DSH NEXT —— 客户端 bundle 与宿主半都只在启动时加载。

**从 GitHub 直接装**（推荐，不需要先发 npm）：

```bash
dsh plugin --profile <你的 profile> add github:zhuanglaihong/dsh-router-worker
```

**从预构建 tarball 装**（免掉 `allowBuilds` 构建授权，最快）：

```bash
dsh plugin --profile <你的 profile> add \
  https://github.com/zhuanglaihong/dsh-router-worker/releases/latest/download/dsh-router-worker.tgz
```

**从本地 clone 装**：

```bash
dsh plugin --profile <你的 profile> add /path/to/dsh-router-worker
```

**在已装好的 DSH NEXT 里**：用插件管理器安装这个目录（`install_bundle`）。

> npm 上暂时还没有本包。发布后这里会多一条 `dsh plugin add dsh-router-worker`。

## 配置

设置里有独立的一级页面「**Router 项目经理**」（`settings.section`，id `router-worker`）：

- **运行限制** —— 直接改宿主的 `subagent.maxActiveSubagents` / `maxDepth`，和 Multitask
  设置页里那两行是同一份配置（改哪个都生效）。
- **子代理使用的模型** —— 给四类 worker（`subagent` / `subagent_fork` / `subagent_ptc` /
  `subagent_minimal`）分别指定 provider + model，留「继承协调者」则不覆盖。这是本包
  `subagentModels` 字段，保存后立即生效、不重启插件。
- **运行时与验证** —— 只读地显示 sqlite 落地路径、Watchdog 三档阈值，以及重启后该看
  哪几行日志，方便核对而不必翻源码。

页面走一个**独立的延迟 fiber**（`ctx.inject(["slots","locale","configForms"], …)`）：
万一这些服务没就绪，只影响设置页，侧栏子对话树照常加载。模型目录取不到时下拉框降级
成「目录不可用」，不会让整页崩掉。

`runtime` / `stateDir` 这两个调度层开关没有进设置页：它们不是 volatile 字段，从面板写会
触发整份配置重载、把插件重启一次。仍在 profile 的 `cordis.patch.yml` 里改（下表）。

没有必须配的项。两个显示开关在实现里已经做成默认值：

| 行为 | 默认 | 存在哪 |
|---|---|---|
| 默认展开还是收起 | 展开 | `localStorage["dsh-router-worker:collapsed"]`，只记被收起的主会话 |
| 摘要截断长度 | 40 字 | 源码 `clip(raw, 40)` |
| 是否显示侧边对话（`Side: ` 开头） | 不显示 | `childrenOf()` 里的过滤——那不是 agent 派的活 |

调度层（0.2.0 起的 Router 模式）还有两个可选配置，写在 profile 的 `cordis.patch.yml` 里那行 `config` 下：

| 配置 | 默认 | 说明 |
|---|---|---|
| `runtime` | `true` | 设成 `false` 就完全不装工单表 —— `ticket_create` 退回「直接派发」，不排队、不持久化、不回收重启残留，也不跑 Watchdog |
| `stateDir` | `$DSH_HOME/state/router-worker` | 换 sqlite 落地目录。`$DSH_HOME` 没设时是 `~/.dsh` |

Watchdog 不需要单独配置：它随 `runtime` 一起启停，阈值（60 秒巡检 / 15 分钟静默 / 30 分钟排队提醒）写在 `lib/watchdog.js` 顶部的常量里。

## 它怎么拿到数据的

两路数据：显示树用宿主已有的会话快照；工单状态条用本包宿主半开的一个同源 HTTP 路由（见下）。

**会话树**（对 Multitask 零依赖）:

1. **父子关系** —— `ctx.sessions.list.getSnapshot().byId` 里每个会话摘要都带 `origin: 'subagent'` 和 `parentId`。这是宿主的持久字段，与哪个插件派的活无关。
2. **短名** —— 同一份快照里的 `projectionsBySession[parentId].values.subagentCatalog[].label`，就是主智能体派单时写下的那行短描述（`subagent` 工具的 `description` 参数）。没有它才退回 `displayTitle`。
3. **运行状态** —— 同一份摘要上的 `running`；有 `useSessionStatus` 时以它为准。更细的过程文本走宿主的 `subagents.live` 路由（右侧任务管理面板用的就是它）。

**工单状态条**：工单表在宿主进程的 sqlite 里，renderer 进程读不到全局键，所以宿主半用
`ctx.inject(['webServer'], cb)` 另开子 fiber 注册 exact GET 路由
`/plugins/dsh-router-worker/tickets`，只外露 `queued|running` 工单的
`{id, parent, title, status, startedAt}`（**不吐** brief / result / error /
worker_session）。客户端 URL 相对 `document.baseURI` 解析 —— 用注入的 `streamBaseUrl`
会跨源被 CORS 拒成 `Failed to fetch`。走子 fiber 而不是把 `webServer` 塞进主
`inject`，是为了服务缺席时只影响状态条、不拖垮整棵会话树。

## 它怎么打开子对话

按优先级三级降级：

1. 宿主右侧的 `subagentchat` 标签页（`sidebarRight.openResource(address, {kind:'subagentchat'})`，地址形如 `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>`）——**不离开当前主对话**就能看子代理过程；
2. `uiWorkspace.openSession(childId)`——普通会话跳转；
3. `sessions.open(childId)`——最老的 API 形状。

宿主版本更新导致某一级失效时，会自动往下一级走，不会白屏。

## 已知边界

- **不是原生行**。宿主把整个左侧浏览区声明成 single 独占插槽（`sidebar.workspaces`，`replaceRisk: shadows-shipped-ui`），插件的 slots 挂不进去，所以本插件用 DOM 注入实现。代价是：子行**没有**置顶 / 重命名 / 归档 / 拖拽排序这些原生行才有的右键菜单能力，点击是「打开」，不是「选中」。
- **宿主重画会重建 DOM**。插件用 MutationObserver 跟进，并且**画之前先断开观察器**，否则会自己触发自己形成死循环。极端情况下（宿主在同一个微任务里连续重建两次）可能抖动一帧。
- **侧边对话不进来**。`Side: ` 开头的是宿主自己的「侧边对话」功能，语义上不是子代理，故意排除。
- **嵌套只画一层**。DSH 的委派深度默认是 1（worker 不能再派），所以一层就够用；真出现孙会话时，它会在自己的父行下被单独渲染。

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-router-worker
```

卸载时 `install()` 返回的清理函数会移除样式表、所有子行和箭头，宿主列表恢复原样。

## 许可

MIT

---

## 与「模式」（agent preset）的关系

本插件从 0.2.0 起**自带一个模式**：「Router 项目经理模式」（preset id `router-worker`），装一次就有了。它从 `dsh-multitask` 1.3.3 分叉而来，保留上游的协调者窄工具面、四类 worker、两级审批闸门与 Windows 工作区 ACL 修复，并在这个基础上加了工单语义：

- **主对话只派单，不干活**：它的工具面被刻意收窄（没有 shell、不能写文件），所以它只能把活开成工单派出去。
- **每张工单必须有短名**：`ticket_create` 的 `title` 是必填参数（2–40 字），原样写进宿主记录的 `subagentCatalog.label` —— 也就是本插件侧栏树上显示的那一行。
- **工单会排队、会记住**：工单落在 `$DSH_HOME/state/router-worker/tickets.db`（sqlite）。宿主名额满了不会把工单判死，只留在队列里等 —— 宿主自己的原文是「Admission does not queue」，排队这件事得由我们做。重启后正在跑的工单会去查子会话还在不在：还在就接着等，没了就标失败并补一条通知，不会让你对着一个永远「运行中」的行发呆。
- **结果回流**：worker 干完把结论交回主对话，主对话只保留结论，不保留过程。宿主自己会发一条完成通知；本插件额外的一张 outbox 表补的是它补不了的两种情况 —— 进程重启后、以及父会话当时不在回合中。投递失败会退避重试（1 秒 → 5 秒 → 30 秒 → 5 分钟），10 次投不出去才放弃并告警。
- **卡死自动收尾（Watchdog）**：还有第三类异常 —— worker 没崩、没发 `turn/end`、却也不再产出（网络挂起、模型卡死、工具僵住）。watchdog 每 60 秒巡检，某张 `running` 工单静默超过 15 分钟就中断它的子会话、标 `failed` 并通知主对话，把占住的并发名额还回去；`queued` 超 30 分钟只提醒一次，不改状态。心跳取 `session/event`（不是 `updated_at`），所以正在流式输出、连续调工具的 worker 不会被误杀；刚重启恢复的工单会先给一个完整宽限期。刻意**不用 LLM 判断跑偏**，只做「静默超时」这一条机械判据。

> 工单表是**可选**的：`node:sqlite` 打不开时自动降级成内存表并告警 —— 功能全在，只是重启即失忆。想让工单落地，把 `runtime` 保持默认（见下面的配置表）。

这个模式与侧栏树是**同一个包里的两件事**，互相不依赖：树只读宿主的父子关系（`origin: 'subagent'` + `parentId`），所以它照常会显示**任何**模式派出的子代理，包括标准模式、别的插件模式、你自己写的 preset。

三种组合方式：

| 做法 | 说明 | 代价 |
|---|---|---|
| 用自带的 Router 模式（推荐） | 新建会话时选「Router 项目经理模式」，装一次就同时得到派单能力与侧栏树 | 该模式刻意收窄主对话工具面，不适合想让主对话亲自写代码的场景 |
| 用别的派单模式 | 例如另外装 `dsh-multitask` 选「Multitask 减震器模式」；本插件照样把它的子代理画成树 | 两个插件，各自独立升级 |
| 在别的模式里写进提示词 | 自己的 preset 里加一句「遇到可并行的子任务就派子代理，派单时写好 `description`」 | 只是提示词，模型可以不照做 |

第三种里的 `description`（`subagent` 等委派工具的可选参数，3–5 个词）就是侧栏那一行短名。自带的 Router 模式用 `ticket_create` 把这件事变成**必填**，所以那边不需要靠提示词自觉。

## 三平台（Windows / macOS / Linux）

纯 Node 逻辑（`store` / `outbox` / `dispatcher` / `watchdog`）和客户端 UI 天然跨平台
（Electron 吃掉 OS 差异）。真正需要验证的是从 `dsh-multitask` 原样复制来的三处
显式平台分支：

- `presets/router-worker/workspace-acl.mjs` —— Windows ACL / 安全描述符（最大风险，
  macOS 上模拟不出 `SetNamedSecurityInfoW failed (Win32 5)`）；
- `presets/router-worker/approval-gate.mjs` —— win32 大小写不敏感的路径比对；
- `presets/router-worker/composition.mjs` —— 按平台启停 `tool-pwsh` / `tool-bash`。

`.github/workflows/ci.yml` 在 `ubuntu-latest` / `windows-latest` / `macos-latest`
× Node 24 三矩阵上跑语法检查、`npm test`、`npm pack --dry-run`；`lib/platform.js` 把这些
分支抽成可注入 `platform` 参数的纯函数，`test/platform.test.mjs` 让 Windows 路径
逻辑能在非 Windows runner 上被演练。单测共 39 个，分四个文件：
`watchdog.test.mjs`（9，卡死巡检）、`platform.test.mjs`（20，三平台路径）、
`providers.test.mjs`（7，四类 worker 的 provider 契约）、
`sidebar-structure.test.mjs`（3，原生 / claude-style 两种 DOM 下侧栏树不脱节）。
`npm test` = `node --test`（无文件参数，Node 自动发现新测试），所以以后加测试不会漏跑。
`package.json` 要求 `engines.node >= 24`（`node:sqlite`）；低版本会降级成内存工单表并告警，不崩但不落库。

**诚实边界**：本机只有 macOS。CI 无显示环境、无法复现 Win32 ACL，所以 Electron
GUI 与 ACL 冒烟只能在真实 Windows / Linux 机器上人工完成 —— 清单在
[docs/PLATFORM.md](docs/PLATFORM.md)。发布口径按
「macOS 真机已验；Windows / Linux 通过 CI 代码层验证（语法 + 单测 + 打包），
GUI 与 ACL 冒烟待真机」写，不夸大。

