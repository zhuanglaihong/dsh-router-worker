# Changelog

本包两个版本线：`0.1.x` 只有侧栏显示；`0.2.x` 起把 Router/Worker 调度合并进来。

## 0.2.0 — 2026-11-09

首个 npm 发布版本。装一次，得到「Router 项目经理模式」+ 侧栏子对话树。

> 注意：0.2.0 的 README 示例里用了真实项目名，已由 0.2.1 替换。请装 0.2.1。

### 发布准备：market 条目 + Release 工作流 + peer 范围修复

- **`peerDependencies` / `dsh.engines.dsh` 的版本范围原来写错了**：`>=0.2.0-rc.1`
  这个看似很宽的范围，按 node-semver 的预发布规则**匹配不到** `0.2.1-rc.2`
  和 `0.2.2-rc.1`（只有当范围里存在某个与目标版本同 `major.minor.patch` 元组、
  且自身带预发布标签的比较符时，预发布版本才被放行）。后果是所有用预发布版
  DSH 的用户 `npm install` 时会撞 `ERESOLVE`。改成显式 `||` 分支：
  `>=0.2.0-rc.1 <0.2.1-0 || >=0.2.1-rc.1 <0.2.2-0 || >=0.2.2-rc.1 <0.3.0-0`，
  实测 `0.2.0-rc.1 / 0.2.0 / 0.2.1-rc.2 / 0.2.1 / 0.2.2-rc.1 / 0.2.2 / 0.2.9`
  全部放行，`0.1.9` 与 `0.3.0-rc.1` 仍被排除。
- 新增 `docs/market-entry.yml`：提给 `awesome-dsh-plugin` 的条目模板（一个插件一个
  文件，`data/plugins/zhuanglaihong__dsh-router-worker.yml`），含 `tarball:` 指向
  预构建包。
- 新增 `.github/workflows/release.yml`：推 `v*` tag 时跑单测、打预构建 tarball、
  挂到 GitHub Release。资产名固定为**不带版本号**的 `dsh-router-worker.tgz` ——
  `releases/latest/download/<文件名>` 里的文件名是照字面取的，带版本号会下次发版就 404。
- `README.md` 的「安装」从一条本地路径扩成四条（GitHub 源码 / 预构建 tarball /
  本地 clone / 插件管理器）。

### 侧栏树改为「结构无关」渲染（兼容自定义皮肤 / Claude-style）

用户启用 `dsh-claude-style` 后侧栏树整块错位（主行变空灰条、子行与连接线断成两截）。
根因不是颜色而是 **DOM 结构**：该皮肤的 `dateGroups` 把每个会话行包进一层 `box`
（`box = row.parentElement`），用 `appendChild(box)` 按日期整体搬动、用
`box.style.display="none"` 整体隐藏、在 box 间插日期标题、往 row 里插 date-chip。
原生结构是 `list > row`，它是 `list > box > row`。

旧实现三处假设崩塌，逐一修掉：

| 旧假设 | 现在 |
|---|---|
| 子树 `insertAdjacentElement("afterend")` 紧跟 row；在 boxed 结构里掉进 box 内部被重排逻辑当杂项丢弃 | `attachHolder()` 仍紧跟 row，但 `holdersAligned()` 要求 `holder.parentElement === row.parentElement`，皮肤重建 DOM 时强制重挂。子树作为 box 的子节点，随 box 一起搬、一起藏 |
| 往主行里塞绝对定位箭头、改 `paddingInlineStart` / 标题 `marginInlineStart`；皮肤插 chip 后标题被推没 | **宿主行一个字节都不动**（删掉 `placeToggle` / `pushTitle` / `clearToggleHost` 整族）。箭头、控制行、状态条、子行全部画在自己的子树块里；`▾ N 条子对话` 是子树第一行 |
| CSS 写死 `left:48px` / `padding-left:64px` | 缩进按主题字号算：`--sat-line = 4 × --dsw-font-size-sm`、`--sat-indent = 6 × --dsw-font-size-sm`，颜色全取 `--dsw-alias-*`。13px 字号 52/78px，16px 字号 64/96px |

「兼容其余 style」不是逐个皮肤写适配，而是**去掉所有对结构的假设**：只认业务属性
`data-row-key`、不改宿主行、子树挂在父行所在容器里、尺寸从主题变量推导。

- `test/sidebar-structure.test.mjs`：3 个零依赖单测，vm 驱动真实 `lib/client.js`，
  同时模拟原生 `list > row` 与 claude-style `list > box > row` 并复现 box 重排，断言
  宿主行始终干净、子树始终与父行同容器、重排后仍连着文档。
- 验证：`/tmp/style-probe.mjs` PASS；headless Chrome CDP 几何在原生 / boxed ×
  13px / 16px 字号下逐像素一致；沙盒真宿主 CDP 零 console / exception / netfail。

### 发布准备：provider 契约决策 + 标准仓库组织

- **移除「私有 provider 收敛成官方 `spawn`」这条硬要求**：核对宿主契约后确认收敛会
  破坏功能。`startActivation(spec)` 把 `spec.provider` 原样写进 `subagent/descriptor`，
  而 `worker-persona.mjs` / `subagent-mode.mjs` / `minimal-guard.mjs` 都以这个字符串
  作为四类 worker 的唯一路由键；两个私有 provider 只是「与上游 in-process spawn
  同形」的别名，不是另造执行引擎。改为**固化契约**：`test/providers.test.mjs`
  7 个用例（provider 名互异、守卫常量逐字一致、capabilities 齐全、重复注册被跳过、
  抛错只告警）。理由与证据见 [docs/PLATFORM.md](docs/PLATFORM.md)。
- 真正未完成的发布硬要求只剩一项：**Windows / Linux 真机 GUI / ACL 冒烟**
  （用户另一台电脑），CI 只覆盖代码层。
- `scripts.test` 改为 `node --test`（无文件参数，Node 自动发现新测试），CI 的
  Unit tests 同步为 `npm test`；单测从 29 增至 **39**（四个文件）。
- 仓库按标准插件仓库组织：`.github/workflows/ci.yml`、`.github/ISSUE_TEMPLATE/`、
  `CONTRIBUTING.md`、`docs/PLATFORM.md`、`CHANGELOG.md`、`LICENSE`(MIT)、
  `README.md`、`test/`，`package.json` 带 repository/bugs/homepage/publishConfig。

### 新增

- **Router 项目经理模式**（preset id `router-worker`）：从 `dsh-multitask` 1.3.3
  分叉，保留其协调者窄工具面、四类 worker、两级审批闸门、纠错立即生效、
  Windows 工作区 ACL 修复。
- 两类自建 worker 后端 `router_worker_ptc` / `router_worker_minimal` 由本包
  宿主半注册。

### 设置页（Router 项目经理）

- `lib/client.js` 新增设置导航一级页「Router 项目经理」（`settings.section` id
  `router-worker`，order 20）。三张卡：①运行限制（改宿主 `subagent.maxActiveSubagents`
  / `maxDepth`，与 Multitask 设置页同一份配置）；②四类 worker 的模型覆盖
  （`subagentModels`，留空＝继承协调者，保存走 `form.mutate`，不重启插件）；
  ③运行时与验证（只读显示 sqlite 路径、Watchdog 阈值、该看哪几行日志）。
- **设置页走独立 fiber**：`mountSettings(ctx)` 用
  `ctx.inject(["slots","locale","configForms"], cb)` 另开一个子 fiber 等服务，
  绝不把这些服务塞进侧栏树那根 fiber 的 `inject`（那样任一服务缺席会把整个
  client bundle 拖到 PENDING，连子对话树都不显示）。`react` 的 `require`
  也包了 try/catch —— 种子表里没有 react 时只跳过设置页，不重现 0.1.0
  那种启动失败。模型目录用宽松的 `ctx.get("remote")` 取，取不到降级不崩。
- `runtime` / `stateDir` 刻意**不放进设置页**：它们不是 `Config` 里的 volatile
  字段，从面板写会让整份配置变更被判成非 volatile、重启本插件；仍走
  `cordis.patch.yml` 的 `config` 块。
- 验证：`/tmp/sat-probe.mjs`（vm 驱动真实 client.js）确认两个 effect 不变、
  设置 fiber 独立注册、页面可渲染、save 写回；`node --test test/*.test.mjs` 9/9 无回归；
  沙盒 CDP 真宿主激活：`sidebarStyle:true`、`settingsCss:true`、零 console /
  exception / netfail。

### Phase 3 — 侧栏树内联工单状态条（轻量版）

用户 m06084 在「独立看板」与「内联状态条」之间选了**轻量版**：不新增面板，
只在主会话行下面补一条汇总。存在的理由是「排队中的工单」—— 它们还没派出去，
没有子会话，在原来的侧栏树里**完全看不见**。

- **数据通道**：工单表在宿主进程的 sqlite 里，侧栏树在 renderer 进程，不能直读。
  宿主半用 `ctx.inject(['webServer'], cb)` 另开子 fiber（不改顶层 `inject=[]`），
  `webCtx.effect` 里注册 exact GET 路由 `/plugins/dsh-router-worker/tickets`，
  只外露 `queued|running` 工单的非敏感字段（**不吐** brief/result/error/
  worker_session/parent_request），配 `connection.requestRejection` 守卫。
  客户端 URL 相对 `document.baseURI` 解析（照 dsh-better-sidebar 的 `hostRouteUrl`
  写法：用注入的 `streamBaseUrl` 会跨源被 CORS 拒成 "Failed to fetch"）。
- **渲染**：`render()` 里凡有子对话**或**有活着工单的主行都画；状态条是「N 运行中 /
  M 排队」chips（收起时也保留＝只看汇总），排队工单逐条列一行标题。轮询 2.5s、
  失败保留旧快照不闪空白、工单指纹进 `signatureOf()` 让状态变化触发重画。
  卸载时清 `AbortController` / timer / 新增 DOM 节点。
- **顺带修一个潜在 bug**：`TREE_ATTR` 与 `ATTR + "-of"` 本是同一字符串，holder 以前
  连写两次把 parentId 覆盖成了 `"1"` —— CSS 只按「属性存在」匹配所以没出事，但父会话
  关联丢了。现在只写一次，值就是 parentId。
- 验证：`/tmp/p3-probe.mjs`（vm 驱动真实 client.js + 假 DOM）确认 p1 显示
  「1 运行中 / 2 排队」+ 三条排队项、p2 只有排队工单也显示、p3 无工单不画、
  无敏感字段泄漏、POST 405；单测通过（当时 29，现 39）；沙盒真宿主 CDP：`sidebarStyle` /
  `settingsCss` / `barCss` 均注入、renderer 内 `fetch` 拿到 `{"ok":true,"value":[]}`、
  **零 console / exception / netfail**。

### 三平台验证与发布（代码层）

用户 m02931/m05541 要求 Windows / macOS / Linux 都适配。诚实边界：本机只有
macOS、无 docker/podman，Electron GUI 与 Windows ACL 冒烟无法在 CI 跑。

- `lib/platform.js`：把三处从 multitask 逐字复制的平台分支抽成**可注入 platform
  参数的纯函数**（`isWindows`/`isCaseInsensitive`/`normalizeSlashes`/`isPathWithin`/
  `tempRoots`/`shellTools`），不读 `process.platform`，让 Windows 专属路径逻辑能在
  macOS/Linux runner 上单测。刻意与 upstream 预设分离，保持 upstream diff 干净。
- `test/platform.test.mjs`：20 个单测 / 75 断言，含「windows 路径逻辑在非 Windows
  主机上被演练」的可模拟性证明，及针对 `approval-gate.mjs:507` 表达式的 oracle 比对。
- `.github/workflows/ci.yml`：`ubuntu-latest`/`windows-latest`/`macos-latest` 三矩阵
  × Node 24，跑语法检查（node 写 walker，bash/pwsh 通用）、`npm test`（自动发现四个
  测试文件、39 用例）、`npm pack --dry-run`；job 注释写明 GUI 冒烟需真机。
- `docs/PLATFORM.md`：四层验证边界 + 发布口径逐字「macOS 真机已验；Windows / Linux
  通过 CI 代码层验证（语法 + 单测 + 打包），GUI 与 ACL 冒烟待真机」+ 真机冒烟清单
  + 「私有 provider 不收敛成 spawn」的宿主契约证据。
- `scripts.test = "node --test"`（无文件参数，Node 自动发现 `test/*.test.mjs`，以后加测试
  不会漏跑）；单测现 9 + 20 + 7 + 3 = **39**。

### Phase 4 — Watchdog（卡死的工单自动收尾）

- **补第三类异常**：`turn/end` 盖正常结束、`recoverOnBoot` 盖进程重启，剩下的空格是
  「子会话还活着却不再发任何事件」（网络挂起 / 模型卡死 / 工具僵住）。那种工单会
  永远挂在 `running`、占住并发名额，后面的 `queued` 永远派不出去。
- `lib/watchdog.js` 是**纯逻辑模块**（零宿主依赖、不 import cordis、可注入假时钟），
  60 秒巡检三条规则：running 静默超 15 分钟 → `interrupt` + 标 `failed` + 通知父会话；
  `worker_session` 为空的 running 行跳过（交给恢复逻辑，不猜）；queued 超 30 分钟
  只 warn 一次、不改状态。outbox 重试 ≥10 次标红由 `outbox.js` 负责，不重复判。
- **心跳来自 `session/event` 而非 `updated_at`**：后者只在状态流转时变，一个正在
  流式输出、连续调工具的 worker 一行都不写，15 分钟后照样会被误杀。
  `runtime.js` 在收到被跟踪子会话的任意事件时调 `touch`。
- **重启不误杀**：`recoverOnBoot` 判 kept 的行恢复后补一次 `touch`；脉搏表为空的第一轮
  巡检只登记不判，绝不用持久 `started_at`（可能 20 分钟前）把还在跑的活判死。
- `interrupt` 用「持久父地址」形状（`interruptByParent` / `{kind:'user', parentSessionId}`）：
  Watchdog 跑在宿主平面，手上没有那个父会话的 live Agent 对象，`kind:'ancestor'` 拿不到。
- 刻意**不用 LLM 判断跑偏**（成本不可靠），只做「静默超时」这一条机械判据。
- `test/watchdog.test.mjs`：9 个零依赖单测（`node --test`，Windows/Linux/macOS 等价），
  覆盖静默判死 / 心跳续命 / 空 worker_session / queued 只 warn / 重启不误杀 /
  isAlive=false 省中断 / 中断抛错仍判失败 / start-dispose / 并发重入。

### Phase 2 — 工单持久化、队列与结果回流

- **工单落到 sqlite**（`lib/store.js`）：`$DSH_HOME/state/router-worker/tickets.db`，
  WAL、单写连接、20 条预编译语句。`node:sqlite` 打不开时自动降级为内存表并告警，
  功能全在、只是重启即失忆 —— 不会让插件装不上。
- **`ticket_create` 从「直接派发」改成「先入队」**：工具只落库就返回，
  派发交给 `lib/dispatcher.js` 的泵。宿主原文是「Admission does not queue」，
  所以撞上 `subagent.maxActiveSubagents` 时**不再把工单判死**，留在队列里等名额。
- **派单泵不自己算名额**，只对宿主的拒绝作反应（认 `ACTIVATION_LIMIT_REACHED` /
  `subagent/delivery-unavailable` 两个码）。理由：宿主的计数口径把不到
  （含别的插件派的活、process-local、每次重新采样），自建预算等于维护第二本账。
- **结果回流走 outbox**（`lib/outbox.js`）：`turn/end` 时把结论落一张通知表，
  由投递泵用 `sessions.prompt(..., 'queue')` 送回父会话。退避 1s→5s→30s→5min，
  10 次投不出去标记 dead 并告警。**重启后 pending 继续投**。
  刻意用 `queue` 不用 `steer`：退避几分钟后送到的通知若插进届时正在跑的那一步，
  与那一步无关，插进去就是捣乱。
- **启动恢复 `recoverOnBoot()`**：`running` 的工单查 `subagents.listChildren(parent)`
  决定保活还是标 `failed: session lost on restart`；宿主没就绪时标 `orphaned`
  而不是猜（猜成 failed 会让用户去重跑一个其实还活着的活）。恢复完成后才允许泵派活，
  避免把活着的工单重复派一遍。
- 运行时句柄通过 `Symbol.for('dsh-router-worker.router-runtime')` 登记到
  `globalThis`，因为宿主半与 preset 半是两个 cordis context（详见 `lib/runtime.js`）。

### Phase 1 — Router 语义

- **五份人格全部中文化**（协调者 + 四类 worker），并把「减震器」换成「项目经理」
  的说法：它现在说的是「你先想清楚再派」，而不是「你只负责挡住噪音」。
- **新增 `ticket_create` 工具**：派活从「调用一个委派工具」变成「开一张工单」。
  `title` 是必填参数（2–40 字），原样作为 `label` 传给 `startActivation`，因此
  侧栏子对话树显示的一定是短名，而不是提示词正文第一行。
  支持 `worker` 参数在 `subagent` / `subagent_minimal` / `subagent_ptc` /
  `subagent_fork` 之间选，provider 没装上时给出可改派的拒绝而不是抛错。
- **协调者人格新增一节「每张工单必须先起名」**：把短名规范从提示词里的软约束
  搬进参数表，并给出好/坏短名对照。
- `ticket_create` 已加进 `DEFAULT_KEEP` 与 composition 的 `keep` 数组 ——
  保留集是白名单，漏了的表现是「模式装上了但协调者看不到这个工具」，且不报错。

### 变更

- 包从「纯显示层」变为「显示层 + 调度层」，安装一次即可。
- `engines.node` 从 `>=20` 升到 `>=24`（后续要用的 `node:sqlite`）。
- 多模式总开关环境变量改名：`DSH_MULTITASK_MULTI_MODE` → `DSH_ROUTER_WORKER_MULTI_MODE`
  （旧的 `[multitask-mode:ptc]` / `[multitask-mode:minimal]` 旧会话标记保留不动）。

### 保留

- 侧栏子对话树的行为、配置、外观与 0.1.0 一致。

## 0.1.0 — 2026-11-07

首个可用版本：在左侧栏每个主对话下缩进显示子对话。

- 缩进树：竖线 + 横枝连接，子行标题从 64px 起
- 短名：优先读宿主 `subagentCatalog[].label`，回退 `displayTitle`，再回退 id 前 8 位
- 状态：`.running` / 结束，实时更新
- 折叠：每个主行独立 ▾/▸，状态存 localStorage
- 只显示最近 3 条，更早的收成「还有 N 条更早的子对话」
- 跨主题：只锚定 `data-row-key` 业务属性，颜色全用 `--dsw-alias-*` 语义变量
- 不依赖任何 agent 模式：只读宿主原生 `origin === 'subagent'` + `parentId`

## 0.2.1 — 2026-11-09

文档与隐私修正版，代码行为与 0.2.0 一致（仅清理注释）。

### 文档整理（本版）

- README 的示例数据换成中性项目名（原来用了真实项目名），渲染截图一并重出。
- README 删除「三平台 / 诚实边界」章节，改为一行「兼容性」+ 指向 `docs/PLATFORM.md`
  与 `docs/ROADMAP.md`；未完成工作不再出现在面向用户的 README 里。
- README 安装章节补上 npm 一条，并把 GitHub / tarball / 本地 clone 三条重排。
- 新增 `docs/ROADMAP.md`：已完成清单、未完成 / 待验证三项、已知缺口、仓库余留。
