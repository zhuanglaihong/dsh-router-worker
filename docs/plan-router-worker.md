# dsh-subagent-tree 0.2.0 — Router + Worker 合并版开发计划

> 基座：`dsh-multitask` 1.3.3（MIT）分叉。目标：把「侧栏子对话显示」和「Router/Worker 调度」**合并进同一个插件**，装一次、一个模式、一条版本线。
>
> 版本线：`0.1.0` = 只有侧栏显示（已提交 `ff24129` + `53abe57`，保存不动）；`0.2.0` = 本计划产出。
>
> 状态：**已确认 fork / 合并单包 / Phase 顺序 / 三平台适配，待开工**。

---

## 一、合并后的形态（与上一版计划的根本区别）

上一版计划是两个插件（`dsh-subagent-tree` 显示 + `dsh-router-worker` 调度）。改为**一个包**：

```
安装一次 → 得到两件事
  ├─ 「Router 项目经理模式」出现在新会话模式选择器里
  └─ 侧栏每个主会话下自动长出子对话树（不需要额外插件）
```

| | 上一版（否） | 现在（是） |
|---|---|---|
| 包数量 | 2 个，装两次 | **1 个，装一次** |
| 模式数量 | 1 个（另一包的） | 1 个，本包自带 |
| 侧栏树 | 独立插件 | **本包 `lib/client.js`，已有代码** |
| 版本线 | 两条 | 一条：0.1.0（显示）→ 0.2.0（显示 + 调度） |

### 包名与仓库身份（**需你一句话拍板**）

- **现状**：包名 `dsh-subagent-tree`，`package.json` 里 repository 指向 `github.com/lighthope/dsh-subagent-tree`，**远程仓库还没建**。
- **问题**：0.2.0 之后它的主要能力是调度，不再是「一棵树」，名字偏了。
- **我的建议**：既然远程还没建，现在改名成本接近零。候选：
  - `dsh-superagent`（最贴目标，但易与官方原型混淆）
  - `dsh-router-worker`（最准，但丢掉显示能力的存在感）
  - 保持 `dsh-subagent-tree`（零成本，名字功能错位）
- **默认动作**：本计划按**保持现名**推进（不改 git 历史、不改已提交的 v1 身份）。你在建远程前一句话就能改，之后改要动 npm 包名 + 目录 + 全部 import。

---

## 二、基于 multitask 的什么（不变）

以下**不重写**，直接带走（约 4,400 行资产）：

| 已有能力 | 实现位置 | 处理 |
|---|---|---|
| 主对话工具面被**机制**收窄（`deny = 可见集 − 保留集`） | `coordinator-guard.mjs` 645 行 | 原样复制，只改常量 |
| 子代理人格注入（按 provider 名在 `agent/created` 窗口） | `worker-persona.mjs` 299 行 | 原样复制，换文本 |
| 四类 worker（完整 / fork / ptc / minimal） | `subagent-mode.mjs` 432 + `minimal-guard.mjs` 731 + `worker-providers.js` 167 | 原样复制 |
| 危险操作两级审批（规则 + 转呈父会话） | `approval-gate.mjs` 1,814 行 | 原样复制 |
| 纠错立即生效（拦 `send_message` 先 interrupt） | `interrupt-before-send.mjs` 273 行 | 原样复制 |
| 摘掉用不上的委派工具（省 10.3% 上下文） | `worker-guard.mjs` 454 行 | 原样复制 |
| Windows 沙箱 ACL 修复 | `workspace-acl.mjs` 923 行 | **原样复制（三平台要求，必须留）** |
| 只读元数据工具 `file_info` | `file-info.mjs` 582 行 | 原样复制 |

全量 10,899 行。分叉必须保留上游版权：

```
MIT License / Copyright (c) 2026 dsh-multitask contributors
```

写进 `LICENSE` 文件（本包版权行 + 上游版权行并列），README 首段写明「fork 自 dsh-multitask 1.3.3（链接），改动见 CHANGELOG」。

---

## 三、比 multitask 多做的四件事（立项理由）

### 空白 1：任务不落地 —— 会话一关，活就没了

派单信息只活在主会话上下文里，应用重启后没有任何记录。

> **Ticket 持久化**：`node:sqlite`（Node 24 自带，零依赖，已在本机实测 `DatabaseSync` 可用、无实验性警告）落库到
> `<DSH_HOME>/state/subagent-tree/tickets.db`（用 `path.join` 拼，三平台通用）。

```sql
CREATE TABLE IF NOT EXISTS ticket (
  id             TEXT PRIMARY KEY,
  parent_session TEXT NOT NULL,
  worker_session TEXT,
  title          TEXT NOT NULL,   -- 3–5 词短名，同时作为 description
  brief          TEXT NOT NULL,
  status         TEXT NOT NULL,   -- queued|running|succeeded|failed|cancelled|handoff|orphaned
  result         TEXT,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ticket_by_parent ON ticket(parent_session, created_at DESC);
CREATE INDEX IF NOT EXISTS ticket_by_status ON ticket(status);
```

### 空白 2：没有队列 —— 撞上限直接报错

现状：连派 10 个 → 报 `active child limit: 8`。

> **Router 队列**：`ticket_create` 只入队并立刻返回 ticket id；`lib/dispatcher.js` 按 `maxActiveSubagents` 取，有空位才真发。
> - 顺序：`created_at` FIFO（先不做优先级）
> - 去重：同 parent + 同 title 且 `queued` 的合并
> - 上限：读宿主 `subagent.maxActiveSubagents`，与 multitask 同一设置项

### 空白 3：结果回流尽力而为 —— 父会话不在就丢

> **Outbox**：结果先落表，再由投递器按退避重试。

```sql
CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  TEXT NOT NULL,
  target     TEXT NOT NULL,
  body       TEXT NOT NULL,
  state      TEXT NOT NULL,   -- pending|delivered|failed
  attempts   INTEGER NOT NULL DEFAULT 0,
  next_at    INTEGER NOT NULL,
  last_error TEXT
);
```

投递走 `subagents.sendMessage(agent, target, content, { signal })`（与 multitask 兜底通知同一条路）。退避 1s → 5s → 30s → 5min，超 10 次标 `failed`。**应用重启后 `pending` 继续投**。

### 空白 4：不知道子代理是干活还是卡死

> **Watchdog**：`ctx.timer.interval(60_000)`
> - `running` 且**最后一次 `session/event`** 超 15 分钟 → `interrupt` + 标 `failed` + 通知父会话
> - `queued` 超 30 分钟 → 只 warn 一次（排队等名额是合法的，不改状态）
> - `outbox.pending` 且 `attempts >= 10` → 标红（由 `outbox.js` 负责，Watchdog 不重复判）
>
> **实现与草案的差异**：不读 `updated_at`（那列只在状态流转时变，一个正在流式输出、
> 连续调工具的 worker 一行都不写，15 分钟后照样会被误杀）；改用 `session/event` 心跳。
>
> **不用 LLM 判断「有没有跑偏」** —— 每次巡检都调模型，成本高且不可靠；时间戳足够。

---

## 四、合并后的包结构

```
dsh-subagent-tree/                    ← 沿用现有仓库
├── package.json                      version 0.2.0
├── cordis.patch.yml                  insert 三行：树 + 宿主引擎 + 预设
├── LICENSE                           MIT（本包 + 上游）
├── README.md                         重写：一个插件两件事
├── CHANGELOG.md                      新增：0.1.0 / 0.2.0
├── lib/
│   ├── index.js                      ★ 从 21 行扩到 ~1,000 行：
│   │                                   preset 注册（id: router-worker）
│   │                                   + provider 注册
│   │                                   + store/outbox/dispatcher/watchdog 装配
│   ├── client.js                     ★ 现有 790 行侧栏树（基本不动）
│   │                                   + Phase 3 工单看板面板
│   ├── worker-providers.js           复制（providers 定义）
│   ├── store.js                      ★ 新增：sqlite 封装
│   ├── outbox.js                     ★ 新增
│   ├── dispatcher.js                 ★ 新增
│   └── watchdog.js                   ★ 新增
├── presets/router-worker/            ★ 从 presets/multitask/ 复制并改名
│   ├── composition.mjs               改名 + persona + 新增 ticket_* 工具行
│   ├── coordinator-guard.mjs         改名（DEFAULT_PRESET_ID、DEFAULT_KEEP 加 ticket_*）
│   ├── worker-persona.mjs            改名 + 中文人格
│   ├── subagent-mode.mjs             改名
│   ├── minimal-guard.mjs             改名
│   ├── worker-guard.mjs              改名
│   ├── approval-gate.mjs             改名
│   ├── interrupt-before-send.mjs     改名
│   ├── workspace-acl.mjs             改名（三平台保留）
│   ├── file-info.mjs                 改名
│   └── preset-dispatch.mjs           改名（拒绝派给自己时的 id）
└── docs/
    ├── PLAN.md                       本文件
    ├── plan-subconversation-menu.md  已有
    └── shots/                        截图
```

### `cordis.patch.yml` 最终形态

```yaml
- insert:
    - id: subagent-tree
      name: 'dsh-subagent-tree'          # 宿主：预设注册 + 调度引擎 + 树（树本体在 client）
    - id: preset-router-worker
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: router-worker
        name: 'Router 项目经理模式'
        description: 主对话是项目经理：拆任务、派工单、汇总结果；读写执行全下放子代理。
        order: 6
        plugins: [...完整清单]           # 由 composition.mjs 导出，见下
```

预设清单的接线方式沿用 multitask 的做法：`lib/index.js` 动态 import `presets/router-worker/composition.mjs` 拿到 `definition`，再 `ctx.agentPresets.register(definition)`。**不把预设清单直接写进 patch**，避免两处维护。

---

## 五、三平台适配（Windows / macOS / Linux）

你的要求是全部适配。逐项列出必须做的事：

| 关注点 | 现状 | 0.2.0 要求 |
|---|---|---|
| **路径拼接** | multitask 里混用 `join()` 与少量字符串拼接 | 全部改 `node:path` 的 `join`/`resolve`；禁止手写 `/` 或 `\\` |
| **`DSH_HOME`** | 已由宿主提供 | 用 `join(dshHome, 'state', 'subagent-tree')`；不假设 `~/.dsh` |
| **`node:sqlite`** | Node 24 内置，三平台一致 | `engines.node: ">=24"`；启动 try/catch，失败降级内存 Map + 告警（功能不中断） |
| **Windows ACL** | `workspace-acl.mjs` 923 行 Windows 专用 | **原样保留**，`process.platform !== 'win32'` 时整段跳过（上游已有判断，需复核） |
| **文件锁 / 并发** | SQLite WAL 单一写连接 | 三平台一致；Windows 上 WAL 文件句柄释放要在 `close()` 里显式调用 |
| **客户端代码** | 浏览器环境，无平台差异 | 无需处理；CSS 只用 `--dsw-alias-*` 变量 |
| **换行 / 编码** | 源码 UTF-8 | `.gitattributes` 加 `* text=auto eol=lf`，避免 Windows 检出后 `node --check` 之外的差异 |
| **临时目录** | 看板导出、pack 验证 | 用 `os.tmpdir()`，不写死 `/tmp` |
| **provider 名** | 纯标识符，无平台差异 | 确保只能是 `[a-z_]+`，Windows 上无大小写敏感问题 |

**验证矩阵**（每个 Phase 结束跑）：

| 平台 | 怎么验 | 状态 |
|---|---|---|
| macOS（本机） | 真机 DSH NEXT 启动 + 沙盒 web profile CDP | 可立即执行 |
| Linux | 沙盒 web profile + CDP（同一套 `/tmp/dshhome` 流程） | 需容器或远程机 |
| Windows | 沙盒 web profile + CDP | **本机无法验证，需你提供一台 Windows 机器或用 GitHub Actions** |

> 诚实说明：macOS 我能端到端验证。Linux 可以靠 Docker 跑 Node 侧单测（store/outbox/dispatcher 是纯 Node，可测），但插件在 Linux 的 DSH 里能否激活我验不了。Windows 同理，只能保证代码里平台分支写对 + 不硬编码路径。**如果你要真机验收，需要给我可访问的机器。**

---

## 六、分阶段实施

### Phase 0 — 合并基座（1 天，比原计划多 0.5 天，因为要并进现有包）

**产出**
1. `presets/router-worker/` 全量复制 + 改名（11 个文件）
2. `lib/worker-providers.js` 复制 + 改名
3. `lib/index.js` 从「只有一行日志」扩成「预设注册 + provider 注册」（先不含 store/outbox，Phase 2 再加）
4. `package.json` 升 0.2.0、`engines.node: ">=24"`、`files` 加 `presets`
5. `cordis.patch.yml` 加预设行
6. `LICENSE` 加上游版权行；`CHANGELOG.md` 建 0.1.0 / 0.2.0 两节
7. `.gitattributes` 加 `* text=auto eol=lf`

**改名清单（顺序不能乱，漏一处就启动失败）**

| 位置 | 原值 | 新值 |
|---|---|---|
| `composition.mjs` | `PRESET_ID = 'multitask'` | `'router-worker'` |
| `composition.mjs` | `name: 'Multitask 减震器模式'` | `'Router 项目经理模式'` |
| `coordinator-guard.mjs` | `DEFAULT_PRESET_ID = 'multitask'` | `'router-worker'` |
| `worker-providers.js` + 所有引用 | `multitask_ptc` / `multitask_minimal` | `router_worker_ptc` / `router_worker_minimal` |
| `composition.mjs` | `SUBAGENT_PROVIDER` / `FORK_PROVIDER` 常量值 | `router_worker` / `router_worker_fork` |
| 全部 `.mjs` | 日志标记 `MULTITASK-*` | `ROUTER-*` |
| 全部 `.mjs` | `'dsh-multitask/...'` 字符串 | `'dsh-subagent-tree/...'` |
| `cordis.patch.yml` 行 id | `multitask` | `router-worker` |
| `lib/index.js` | `ownEntryId` / stateDir 名 | `subagent-tree` |

> **provider 名绝不能沿用 `multitask*`** —— 会触发 `DUPLICATE_PROVIDER`，两个模式一起挂。这是 Phase 0 第一验收项。

**验收**
- [ ] `node --check` 全部 12 个 js/mjs 文件通过
- [ ] `grep -rc "multitask\|MULTITASK" lib presets | grep -v ":0"` → 无输出
- [ ] 沙盒 web profile（`/tmp/dshhome` + `treebet`）里启动：日志出现 `ROUTER-PRESET-DECLARED`，无 `DUPLICATE_PROVIDER`、无 `Duplicate agent preset`、无激活失败
- [ ] 模式选择器出现「Router 项目经理模式」
- [ ] 侧栏树仍正常（现有 `lib/client.js` 未被破坏）
- [ ] 与已装的 `dsh-multitask` 共存时两者都正常（先不卸载它）

**卡点预案**：如果预设声明导致 `web boot: 1 entry did not activate`（上次就是这么炸的），先用「预设行注释掉、只留树」验证包本身健康，再逐步加回 —— 沙盒里试，别直接让你重启。

---

### Phase 1 — Router 语义与短名规范（1 天）

**产出**
- `COORDINATOR_PERSONA` 重写：项目经理口吻 + 中文（你在 m02236 第 2 点提过子对话提示词是英文，这次一并解决）
- `WORKER_PERSONA` / `FORK_PERSONA` / PTC / minimal 人格中文化
- 硬规则：**每张工单必须有 3–5 词短名**，作为 `description` 传给 `startActivation`
- `ticket_create` 的 JSON Schema：`{ title: string(2–40 字), brief: string, cwd?: string, model?: string }`

**为什么短名重要**：`subagent` 的 `description` 会进宿主的 `subagentCatalog[].label`，而本包的侧栏树正是读这个字段 —— **改一处，侧栏显示立刻变好**。这是显示层与调度层唯一的耦合点，写进 README。

**验收**
- [ ] 派 3 个任务，侧栏显示 `#1 核对版本号` 这类短语，不是提示词正文
- [ ] 子代理人格是中文
- [ ] 主对话调 `bash` 失败（工具不在可见面）
- [ ] 用户中途插话，Router 能回应且不阻塞子代理

---

### Phase 2 — store / outbox / dispatcher（1.5 天）

**产出**
- `lib/store.js`：`openStore(dshHome)`、`createTicket` / `claimNext` / `markRunning` / `markSucceeded` / `markFailed` / `listByParent` / `recoverOnBoot`；WAL；单写连接；`close()` 显式释放
- `lib/dispatcher.js`：队列消费 + 上限读取 + 去重
- `lib/outbox.js`：落表 + 退避投递
- `lib/remote.js`：客户端可调 `tickets.list` / `tickets.cancel` / `tickets.retry`

**启动恢复三段**（最关键）：
```
onBoot:
  1. ticket status='running' → subagents.listChildren(parent)
       子会话还活着 → 保持 running
       没了        → failed，error='session lost on restart'
  2. outbox state='pending' → 立刻尝试投递
  3. ticket status='queued' → 重新进队列
```

**验收**
- [ ] 派 2 个活 → `⌘Q` 杀应用 → 重启 → 看板显示 2 张 running
- [ ] 重启后子代理完成 → 结果仍回到 Router 会话（outbox 投递成功）
- [ ] `maxActiveSubagents=1` 时连派 3 个 → 第 2、3 张 `queued`，不报错
- [ ] 杀掉子会话 → 重启后该工单 `failed` 且原因写明
- [ ] Node 24 上 sqlite 正常；人为让 `node:sqlite` 不可用 → 降级内存 Map 且告警，不崩

---

### Phase 3 — 工单看板（1 天）

**产出**
- `lib/client.js` 里 `sidebar.panellist` 注册一个图标（`replaceRisk: none`，安全座），点开是看板
- 内容：按状态分组（运行中 / 排队 / 完成 / 失败），每行短名 + 耗时 + 状态点
- 点行 → `uiWorkspace.openSession(workerSession)`
- 失败行「重试」→ `tickets.retry`

**不替换 `sidebar.workspaces`**（`replaceRisk: shadows-shipped-ui`，会遮住官方 UI）。

**验收**
- [ ] 侧栏多一个图标，点开看到所有工单
- [ ] 子代理完成 → 那行从「运行中」变「完成」
- [ ] 点击打开对应子会话
- [ ] claude style 与其他主题下都正常（只用 `--dsw-alias-*`）

---

### Phase 4 — Watchdog（0.5 天）✅ 已实现（m05576 后用户要求补做）

- `lib/watchdog.js`：纯逻辑、零宿主依赖、可注入假时钟；`ctx.timer.interval(60_000)`，三条规则，日志标记 `ROUTER-WATCHDOG-*`
- **心跳来自 `session/event`**：`runtime.js` 在收到被跟踪子会话的任意事件时调 `touch`，不靠 `updated_at`（那列只在状态流转时变，流式输出的 worker 会被误杀）
- **重启保护**：`recoverOnBoot` 判 kept 的工单在恢复后补一次 `touch`；脉搏表为空的第一轮巡检只登记不判，绝不用持久 `started_at`（可能 20 分钟前）把还在跑的活误杀
- `interrupt` 用「持久父地址」形状（`interruptByParent` / `{kind:'user', parentSessionId}`），因为 Watchdog 在宿主平面拿不到 live 父 Agent
- `test/watchdog.test.mjs`：9 个零依赖单测（静默判死 / 心跳续命 / 空 worker_session 跳过 / queued 只 warn 一次 / 重启不误杀 / isAlive=false 省中断 / 中断抛错仍判失败 / start-dispose / 并发重入）
- **验收**：`node --test test/watchdog.test.mjs` 全过；接线探针确认 60s 与 2s 定时器共存、dispose 摘干净

---

### Phase 5 — 文档、三平台验证、发布（1 天）

- `README.md` 重写：一个插件两件事、fork 声明、与 multitask 对照、配置项、三平台说明
- `CHANGELOG.md`：0.1.0（显示）/ 0.2.0（合并）
- `docs/DESIGN.md`：架构、状态机、恢复逻辑、已知边界
- 三平台验证矩阵（见第五节）
- `pnpm pack` → tarball 装进干净 profile 实测（沿用 dsh-subagent-tree 那套沙盒 + CDP 法）
- `git tag v0.1.0`（补打在现有 commit 上）+ 0.2.0 commit

**总计约 6 个工作日。**

---

## 七、风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| **合并后一炸全炸** | 侧栏树和调度在同一个 client bundle 里，预设注册失败会连累显示 | (1) 预设注册全部 `try/catch` + 失败只告警不抛；(2) 树的 `install()` 已有软失败包裹；(3) 每个 Phase 都在沙盒 CDP 验激活，不直接请用户重启 |
| **DSH 版本漂移** | `0.2.2-rc.1` 是预览版，插件 API 每月变（`persona` 配置项就是这么没的） | `engines.dsh` 写死下限；关键 API 用 `ctx.inject` + 能力探测，缺了安静降级 |
| **上游更新跟不上** | multitask 修 bug 我们收不到 | 分叉时记上游 commit；每季度 diff `presets/` 摘补丁 |
| **`node:sqlite` 需 Node 24** | 低版本装上崩 | `engines.node: ">=24"`；try/catch 降级内存 Map |
| **改名漏改** | 模式不出现 / `DUPLICATE_PROVIDER` | 批量替换后 `grep` 归零 + `node --check` + 沙盒真启动 |
| **三平台只验了 macOS** | Linux/Windows 可能因路径或 ACL 崩 | 平台分支代码写对；纯 Node 部分用 Docker 跑单测；**真机验收需你提供机器** |
| **`steer` 需父会话有打开回合** | 结果回流失败 | outbox 落库 + 退避重试，而非一次性 `sendMessage` |

---

## 八、边界（明确不做）

| 不做 | 理由 |
|---|---|
| 分布式 / 跨机器 | 需中心调度 + endpoint daemon，插件层做不了 |
| 事件驱动（GitHub / IM） | 另一个维度，你要的是 Router + Worker |
| 权限模型（Eval / Mandate / Subscription） | 本地单人，`ask` 审批卡够用 |
| LLM 判断子代理跑偏 | 巡检成本高且不可靠 |
| 优先级队列 / 依赖 DAG | 过度设计，FIFO 先跑通 |

---

## 九、开工前唯一待你决定

**包名**：保持 `dsh-subagent-tree`，还是趁远程没建改成 `dsh-superagent` / `dsh-router-worker`？

不改的话我直接按现名推进 Phase 0。

---

## 十、范围调整（m05541 后用户确认，2026-11-08）

用户明确：**只要「第一部分 Router 项目经理模式」+ 子对话显示**；文章其余模块（事件驱动、
面向人的交互、计算/状态/环境分离）都不要。逐条校准如下。

### 更正两处标错的地方

- **「计算/状态/环境分离」从未实现**。文章该模块指无状态云端循环 + endpoint daemon
  + BYOM，需要另写一套 Engine。Phase 2 做的只是「工单状态从进程内存挪进 sqlite」，
  目的是**让 Router 派出去的活不丢单**，不是把 agent 变成无状态循环。两者不要混为一谈。
- **事件驱动一行未写**。订阅 `session/event` 的 `turn/end` 只是 dispatcher 判断
  「这个 worker 干完了」的信号；透传 / 投机执行 / Chain of Recall 均未实现。

### 已落地 vs 不做

| 项 | 决定 | 说明 |
|---|---|---|
| 双层架构 Router/Worker | ✅ 保留 | Phase 0 模式声明 + Phase 1 中文人格 / 收窄 41 工具 / `ticket_create` / 短名 |
| 子对话侧栏树 | ✅ 保留 | 用户 m04784「保留子智能体显示的插件」 |
| Phase 2 store / outbox / dispatcher | ✅ 保留，先实测 | 用户选「保留，先跑测试」；它是**可选底座**，不是文章模块。`config.runtime: false` 可整块关掉，`ticket_create` 退回直接派单 |
| Phase 3 工单看板 | ✅ 保留 | 用户「我觉得 3 可以保留」；走 `sidebar.panellist`（replaceRisk: none） |
| Phase 4 Watchdog | ✅ 已实现（m05576 后改为做） | 用户 m05576「那我觉得watchdog也有必要做。你可以补充一下」；见下节 |
| Phase 5 三平台验证 + 发布 | ✅ 保留，且为硬要求 | 用户「之后要发布肯定所有平台都要验证」；见下节 |
| 文章的其余模块 | ❌ 明确不做 | 事件驱动 / 面向人的交互 / 计算状态环境分离 / 权限模型 / 优先级 DAG |

### Watchdog 是干什么的（用户 m05576 要求补做，已实现）

`ctx.timer.interval(60_000)` 每 60 秒巡检，running 超 15 分钟无进展 →
`interrupt` + 标 `failed` + 通知父会话；queued 超 30 分钟标黄（只 warn，不改状态）；
outbox 重试超 10 次标红由 `outbox.js` 的 `markOutboxDead` 负责，Watchdog 不重复判。

它补的是**唯一一个缺口**：worker 没崩、没发 `turn/end`、但也不再产出（网络挂起、
模型卡死、进程僵住），此时 `session/event` 和 `agent/disposed` 都不会来，工单会永远挂在
running，占住一个并发名额，后面 queued 永远派不出去。文章里它是「持久自愈」的一部分。

Phase 2 只覆盖了两类异常：重启后 `recoverOnBoot` 把失联的 running 标失败、正常结束由
`turn/end` 判成功。Watchdog 补第三类。用户 m05576 认为有必要，故从「暂不做」改为已实现。

**刻意不做 LLM 判断跑偏**（成本不可靠），只做「静默超时」这一条机械判据。

### 三平台验证（发布硬要求，诚实边界）

本机只有 macOS，且无 Docker / podman / gh。分层验证：

1. **纯 Node 代码层（可全自动，三平台等价）** — 新增 `test/` 下零依赖脚本，
   覆盖 store / outbox / dispatcher / `approval-gate` 的路径判定（`caseInsensitive`
   参数可在一台机器上同时模拟 win32 与 POSIX 语义）；配一份 GitHub Actions
   `ubuntu-latest / windows-latest / macos-latest` 矩阵跑 `node --check` + 单测 +
   `pnpm pack` 完整性。这一步能证明**逻辑**在三平台一致。
2. **Electron GUI 层（需真机）** — 预设激活、侧栏渲染、主题兼容，只能在
   Windows / Linux 真机上由用户提供机器验收；CI 跑不了无头 Electron 的完整 GUI。
   发布说明里如实写「已在 macOS 真机验证，Win/Linux 通过 CI 代码层验证」。

平台相关代码集中在 `presets/router-worker/workspace-acl.mjs`（`IS_WINDOWS`）、
`approval-gate.mjs`（win32 路径与大小写）、`composition.mjs:1119-1124`（按 platform
启停 `tool-pwsh` / `tool-bash` 行）。这三处是 CI 之外仍需真机确认的重点。
