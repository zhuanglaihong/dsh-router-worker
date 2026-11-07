# dsh-router-worker 设计草案

> 状态：**只写方案，未开工**。目标是做一个**真正的 Router + Worker 双层架构**插件，替代现在「显示层用 dsh-subagent-tree、派单层靠 dsh-multitask」的组合。

## 为什么不能只靠现成插件

现有的两块拼起来能凑出体验，但各缺一半：

| | dsh-multitask | dsh-subagent-tree | 缺的 |
|---|---|---|---|
| 主对话只说不做 | ✅ 机制收窄工具面 | — | — |
| 后台派单不阻塞前台 | ✅ | — | — |
| 结果自动回流 | ✅ 转呈 + 唤醒 | — | — |
| 子对话可见 | ❌ 只有头部计数 | ✅ 缩进树 | — |
| 多任务并行编排 | ⚠️ 单线程派单 | — | **Router 没有队列/优先级** |
| 任务生命周期 | ⚠️ 靠子代理自觉 | — | **没有 ticket 状态机** |
| 跨重启存活 | ❌ 会话结束就没了 | — | **没有持久化** |

所以真正要补的是 **Router 作为驻留调度器**，不是「再包一层提示词」。

## 架构

```
                ┌─ 用户消息（任意入口）───────────────┐
                ▼                                     │
        ┌───────────────┐   合并/排队    ┌──────────────┴──┐
        │  Router       │──────────────▶│  Ticket 队列     │
        │  (主会话)      │◀──────────────│  持久化 SQLite   │
        └───────┬───────┘   状态回报      └─────────────────┘
                │ 派单（写 ticket_id）
    ┌───────────┼───────────┬───────────┐
    ▼           ▼           ▼           ▼
 Worker-1    Worker-2    Worker-3    Watchdog
 (isolated)  (isolated)  (isolated)  (巡检)
    │           │           │
    └───────────┴───────────┴──▶ 结果回流 → Router → 用户
```

### Router（主会话，工具面收窄）

**只保留**：`ticket_create` / `ticket_list` / `ticket_cancel` / `subagent` / `send_message` / `list_agents` / `job_*` / `todo_write` / `ask_user_question` / `read`（只读核对用）。

**摘除**：`bash` / `write` / `edit` / 网络类 / 插件管理类 / `cordis_inspect_*` / `load_workspace_dependencies`。

判断逻辑（写进 persona，但由**工具面**兜底，不靠自觉）：
1. 收到需求 → 判断是否可拆成互不依赖的子任务
2. 拆 → 一个子任务一张 ticket，同一条消息里并行派
3. 不拆 → 直接派一个
4. 用户中途追问 → 找到对应 ticket，`send_message` 续接而不是重开

### Worker（子会话）

- 每个 tile 一个独立 session，`parentId` 指向 Router 会话 → `dsh-subagent-tree` 自动就能画出来，**零改动复用**
- 任务书自包含（目标 / 已验证事实 / 写范围 / 停止条件 / 报告格式）
- 短名：派单时传 `description`（3–5 词），会进 `subagentCatalog[].label`，侧栏直接显示

### Ticket 状态机

```
queued → running → (succeeded | failed | cancelled | handoff)
                 └─ handoff：需要人决策，挂起等用户
```

持久化到 `$DSH_HOME/state/router-worker/tickets.db`（SQLite，单写连接，WAL）。这样：
- 应用重启后 Router 能看到没干完的活
- 用户问「上次那个任务怎么样了」有地方查

## 分阶段实现

### Phase 1 — Router 壳（1–2 天）

| 文件 | 内容 |
|---|---|
| `package.json` | `dsh.bundle.patch` + `dsh.client.platform: web` |
| `cordis.patch.yml` | 两行 insert：插件本体 + `router-worker` agent preset |
| `presets/router-worker/composition.mjs` | 完整 plugin 清单（照抄 standard 21 行），摘掉 bash/write/edit 等 |
| `lib/index.js` | host：注册 preset，注册 `ticket` remote |
| `lib/client.js` | client：注册 `sidebar.panellist` 面板（ticket 看板） |

验收：新会话能选「Router 模式」，主对话里 `bash` 报 `tool not found`。

### Phase 2 — Ticket 持久化（半天）

- `lib/store.js`：better-sqlite3 或 node:sqlite（Node 24 自带 `node:sqlite`，零依赖）
- 表：`ticket(id, parent_session, brief, title, status, created_at, updated_at, worker_session, result)`
- host remote：`ticket.create` / `ticket.update` / `ticket.list`

验收：建一张 ticket → 杀掉应用 → 重启 → ticket 还在。

### Phase 3 — 派单与回流（1 天）

关键点：dsh-multitask 已经验证过这条路可行，直接抄它的机制：

```js
// 派单：调 subagent 工具，同时把返回的 agentId 写进 ticket
const { agentId } = await ctx.tools.call("subagent", {
  description: ticket.title,
  prompt: ticket.brief,
});
store.update(ticket.id, { status: "running", workerSession: agentId });

// 回流：监听子会话结束事件 → 写 result → 把结论 steer 进 Router 会话
ctx.on("agent/status", (payload) => {
  if (payload.state !== "inactive") return;
  const ticket = store.byWorker(payload.agentId);
  if (!ticket) return;
  store.update(ticket.id, { status: "succeeded", result: payload.summary });
  ctx.get("sessions").prompt(ticket.parentSession, `[ticket ${ticket.id}] 完成：${payload.summary}`, "steer");
});
```

**注意**：`sessions.prompt(..., "steer")` 要求父会话有一个打开的回合；父会话空闲时会失败 —— dsh-multitask 的解法是先用消息通道唤醒父会话再重试一次（`relayRetryWindowMs` 默认 10000）。

验收：派两个互不依赖的活 → 前台立刻能说话 → 两个都回来了。

### Phase 4 — Watchdog（半天，可选）

定时任务（`ctx.timer.interval`）每 5 分钟扫一遍：
- `running` 超过 N 分钟没动静 → 判为卡死 → `interrupt_agent` + 标记 failed
- queue 里积压超过 N 条 → 提示用户

## 明确不做

- **不做跨机器分布式**。文章里的「计算/状态/环境分离」需要中心调度 + endpoint daemon，那是产品级工程，插件层面不做。
- **不做事件驱动**（GitHub / IM 触发）。那是另一个维度，用户明确说先只要 Router + Worker。
- **不做权限模型**（Eval / Mandate / Subscription）。本地单人使用，`ask` 审批卡够用。

## 与 dsh-subagent-tree 的关系

**不合并，作为依赖关系声明**：
- `dsh-router-worker` 只负责「派单 + 追踪」
- 树形显示由 `dsh-subagent-tree` 独立提供（它读的是宿主原生 `origin === 'subagent'` + `parentId`，不需要知道谁派的）
- 两个插件都装上就是完整体验；只装 tree 也能看 multitask 派的子代理

这样边界干净，tree 可以独立发布、独立演进而不用跟着 Router 改。

## 待确认

1. Ticket 队列要不要优先级？（现在打算：`created_at` FIFO）
2. 一个 ticket 失败了要不要自动重试？（打算：不自动重试，标记 failed 等 Router 决定）
3. Router 会话被用户归档/删除，它的 ticket 怎么处理？（打算：标记 orphaned，不再派新活，但保留记录）
