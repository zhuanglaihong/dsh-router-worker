/**
 * store — 工单与投递队列的持久层。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * Phase 1 的工单表是 `ticket-create.mjs` 里的一个进程内 `Map`。它能证明「起名 →
 * 侧栏显示」这条路走得通，但一按 ⌘Q 就全没了：重启后没人知道刚才派出去过什么，
 * 更没法回答「那张工单后来怎么样了」。而 Router 模式的价值恰恰在于「用户可以
 * 离开，回来还看得见」，所以工单必须落在磁盘上。
 *
 * 两张表，职责不重叠：
 *
 *   ticket  —— 一张工单的一生（排队 / 运行 / 成功 / 失败 / 取消）。这是**状态**。
 *   outbox  —— 还没送到父会话的结果通知。这是**动作**，它带重试与退避。
 *
 * 分开的理由：状态是幂等的（同一张工单被标三次 failed 还是 failed），而动作不是
 * （同一条通知投两次，用户会看到两句重复的话）。混在一张表里迟早会出现「状态已终态
 * 但通知没送出去，于是整行再也不会被扫到」——那是最难查的一类丢消息。
 *
 * ── 为什么是裸 `node:sqlite` 而不是宿主的 `storageDomain` ────────────────────
 *
 * 宿主有 `ctx.storageDomain.open(spec)`，用它能省掉自己管连接与 WAL。代价是它要求
 * 用 `defineDomain` + `domainTable` + zod schema 把表声明一遍，也就是**多一个运行时
 * 依赖 + 学一套 DDL 之外的语言**。本插件的两张表总共 8 个索引列，用裸 sqlite 是
 * 30 行 DDL 的事。
 *
 * 所以这里先用裸 `node:sqlite`，但把接口收成一个扁平的对象（`createTicket` /
 * `markFailed` / …）—— 日后要换 storageDomain，只要再写一个实现同一接口的对象即可，
 * 调用方一行都不用改。**接口选择在这里，实现选择不在。**
 *
 * ── 降级：sqlite 不可用时怎么办 ─────────────────────────────────────────────
 *
 * `node:sqlite` 在 Node 22 上要 `--experimental-sqlite`，Electron 各版本捆绑的 Node
 * 也各不相同。让它「不可用 ⇒ 整个 Router 模式挂掉」是不可接受的：工单丢失是数据问题，
 * 而插件装不上是可用性问题，后者严重得多。
 *
 * 所以 `openStore()` **永不抛错**：sqlite 打不开就退回内存实现，功能全在、只是重启
 * 即失忆，并通过一条 warn 把这件事说清楚。调用方不需要知道当前用的是哪一个 —— 但
 * `store.durable` 会如实回答，好让设置页/看板能提示「当前不持久」。
 *
 * @module dsh-subagent-tree/lib/store
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * 工单状态。顺序即看板的展示顺序，也是「越靠后越终态」的粗略排序。
 *
 * - `queued`   已登记，等一个执行名额。
 * - `running`  子会话已创建，正在干活。
 * - `succeeded` 子代理正常结束。
 * - `failed`   子代理报错、被杀，或重启后确认会话已丢失。
 * - `cancelled` 用户在看板上取消。
 * - `orphaned` 重启后既找不到子会话、又找不到失败证据 —— 诚实地说「不知道」，
 *              而不是猜成 failed（猜错会让用户去重跑一个其实还活着的活）。
 */
export const TICKET_STATUS = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'orphaned']

/** 终态集合：这些状态不会再被调度器捡起来。 */
export const TERMINAL_STATUS = new Set(['succeeded', 'failed', 'cancelled', 'orphaned'])

/** outbox 行状态。`pending` 会被投递，`sent` / `dead` 是终态。 */
export const OUTBOX_STATE = ['pending', 'sent', 'dead']

/**
 * 退避梯子（毫秒）：1s → 5s → 30s → 5min，之后一直是 5min。
 *
 * 前三级很短是因为「父会话刚好在忙」这种失败几秒后就好了；封顶 5min 是为了让一台
 * 睡了一夜的机器醒来后不至于每分钟被叫醒一次去投一条已经过时的通知。
 */
export const OUTBOX_BACKOFF_MS = [1_000, 5_000, 30_000, 300_000]

/** 一条 outbox 行最多尝试几次就判死（`state='dead'`）。 */
export const OUTBOX_MAX_ATTEMPTS = 10

/**
 * 解析 DSH 状态目录。
 *
 * 判据与宿主其它插件一致：`DSH_HOME` **非空**才算数（否则退回 `~/.dsh`）。
 * 注意 `DSH_HOME=''` 不能当作「根目录」—— 那是空字符串，join 出来是相对路径，
 * 会写到进程 cwd 里去，而 cwd 在桌面端是不可预测的。
 *
 * @param override - 显式指定的目录（测试用）；不传则按上面的规则算。
 * @returns 绝对路径。
 */
export function resolveStateDir(override) {
  if (typeof override === 'string' && override.trim() !== '') return override
  const home = process.env.DSH_HOME
  if (typeof home === 'string' && home !== '') return join(home, 'state', 'router-worker')
  return join(homedir(), '.dsh', 'state', 'router-worker')
}

/** 建表 DDL。`IF NOT EXISTS` 让「升级安装」不需要迁移脚本。 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ticket (
     id             TEXT PRIMARY KEY,
     parent_session TEXT NOT NULL,
     parent_request TEXT,
     worker_session TEXT,
     title          TEXT NOT NULL,
     brief          TEXT NOT NULL,
     worker         TEXT NOT NULL,
     status         TEXT NOT NULL,
     result         TEXT,
     error          TEXT,
     attempts       INTEGER NOT NULL DEFAULT 0,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL,
     started_at     INTEGER,
     finished_at    INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS ticket_by_parent ON ticket (parent_session, created_at)`,
  `CREATE INDEX IF NOT EXISTS ticket_by_status ON ticket (status, created_at)`,
  `CREATE TABLE IF NOT EXISTS outbox (
     id             TEXT PRIMARY KEY,
     ticket_id      TEXT NOT NULL,
     parent_session TEXT NOT NULL,
     body           TEXT NOT NULL,
     state          TEXT NOT NULL,
     attempts       INTEGER NOT NULL DEFAULT 0,
     next_at        INTEGER NOT NULL,
     last_error     TEXT,
     created_at     INTEGER NOT NULL,
     updated_at     INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS outbox_due ON outbox (state, next_at)`,
]

/**
 * 把 sqlite 的 `null` 原生对象转成普通对象。
 *
 * `DatabaseSync` 默认返回 null-prototype 对象（`[Object: null prototype] {...}`）。
 * 它本身能用，但一旦被 `JSON.stringify` 以外的方式处理（例如 `Object.assign`、
 * 展开运算、某些序列化器）就会出现「属性明明在却拿不到」的怪事。这里统一转成
 * 普通对象，把差异挡在存储层。
 *
 * @param row - sqlite 返回的行，或 undefined。
 * @returns 普通对象，或 undefined。
 */
function plain(row) {
  return row === undefined || row === null ? undefined : { ...row }
}

/**
 * 打开一个 sqlite 工单库。
 *
 * @param options - `{ dir, logger }`。
 * @returns 实现了本模块接口的对象；**打不开时抛错**（由 `openStore` 捕获并降级）。
 */
function openSqliteStore(options) {
  // 延迟到函数内部 require，好让「模块不存在」在 try/catch 的保护范围内发生。
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite')

  const dir = options.dir
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'tickets.db')

  const db = new DatabaseSync(file)
  // WAL 让「一边写工单一边被看板读」不会互相阻塞；`journal_mode` 是持久设置，
  // 但它每次都返回一行结果，必须用 exec 而不是 prepare().run()。
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
  } catch {
    // 个别平台/文件系统不支持 WAL（例如某些网络盘）。退回默认日志模式仍能用，
    // 只是并发读写会互相等一下 —— 不值得为此拒绝启动。
  }
  for (const statement of SCHEMA) db.exec(statement)

  /** 预编译语句缓存：DDL 之后表结构就固定了，重复 prepare 是纯浪费。 */
  const sql = {
    insertTicket: db.prepare(
      `INSERT INTO ticket (id, parent_session, parent_request, title, brief, worker, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ),
    getTicket: db.prepare('SELECT * FROM ticket WHERE id = ?'),
    listByParent: db.prepare('SELECT * FROM ticket WHERE parent_session = ? ORDER BY created_at DESC'),
    listByStatus: db.prepare('SELECT * FROM ticket WHERE status = ? ORDER BY created_at ASC'),
    listAll: db.prepare('SELECT * FROM ticket ORDER BY created_at DESC LIMIT ?'),
    nextQueued: db.prepare(`SELECT * FROM ticket WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`),
    countRunning: db.prepare(`SELECT COUNT(*) AS n FROM ticket WHERE status = 'running'`),
    countRunningByParent: db.prepare(`SELECT COUNT(*) AS n FROM ticket WHERE status = 'running' AND parent_session = ?`),
    setStatus: db.prepare('UPDATE ticket SET status = ?, updated_at = ? WHERE id = ?'),
    setRunning: db.prepare(
      `UPDATE ticket SET status = 'running', worker_session = ?, started_at = ?, updated_at = ?,
         attempts = attempts + 1 WHERE id = ?`,
    ),
    setSucceeded: db.prepare(
      `UPDATE ticket SET status = 'succeeded', result = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    ),
    setFailed: db.prepare(
      `UPDATE ticket SET status = 'failed', error = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    ),
    insertOutbox: db.prepare(
      `INSERT INTO outbox (id, ticket_id, parent_session, body, state, attempts, next_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    ),
    dueOutbox: db.prepare(
      `SELECT * FROM outbox WHERE state = 'pending' AND next_at <= ? ORDER BY next_at ASC LIMIT ?`,
    ),
    getOutbox: db.prepare('SELECT * FROM outbox WHERE id = ?'),
    markOutboxSent: db.prepare(`UPDATE outbox SET state = 'sent', updated_at = ? WHERE id = ?`),
    markOutboxRetry: db.prepare(
      `UPDATE outbox SET attempts = attempts + 1, next_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    ),
    markOutboxDead: db.prepare(
      `UPDATE outbox SET state = 'dead', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?`,
    ),
  }

  const now = () => Date.now()

  return {
    durable: true,
    file,

    createTicket(record) {
      const id = typeof record?.id === 'string' && record.id !== '' ? record.id : randomUUID()
      const at = now()
      sql.insertTicket.run(
        id,
        String(record.parentSession),
        record.parentRequest ?? null,
        String(record.title),
        String(record.brief),
        String(record.worker ?? 'subagent'),
        at,
        at,
      )
      return id
    },

    getTicket(id) {
      return plain(sql.getTicket.get(String(id)))
    },

    listByParent(parentSession) {
      return sql.listByParent.all(String(parentSession)).map(plain)
    },

    listByStatus(status) {
      return sql.listByStatus.all(String(status)).map(plain)
    },

    listAll(limit = 200) {
      return sql.listAll.all(limit).map(plain)
    },

    nextQueued() {
      return plain(sql.nextQueued.get())
    },

    countRunning(parentSession) {
      const row =
        parentSession === undefined
          ? sql.countRunning.get()
          : sql.countRunningByParent.get(String(parentSession))
      return Number(row?.n ?? 0)
    },

    markRunning(id, workerSession) {
      const at = now()
      sql.setRunning.run(workerSession ?? null, at, at, String(id))
    },

    markSucceeded(id, result) {
      const at = now()
      sql.setSucceeded.run(result ?? null, at, at, String(id))
    },

    markFailed(id, error) {
      const at = now()
      sql.setFailed.run(error ?? null, at, at, String(id))
    },

    /** 把一张工单退回 `queued`（名额满了、或取消后又被重试）。 */
    markQueued(id) {
      sql.setStatus.run('queued', now(), String(id))
    },

    /** 直接设成任意状态 —— 只给 `cancelled` / `orphaned` 这类没有专用方法的状态用。 */
    setStatus(id, status) {
      sql.setStatus.run(String(status), now(), String(id))
    },

    enqueueOutbox(record) {
      const id = typeof record?.id === 'string' && record.id !== '' ? record.id : randomUUID()
      const at = now()
      sql.insertOutbox.run(
        id,
        String(record.ticketId),
        String(record.parentSession),
        String(record.body),
        typeof record.nextAt === 'number' ? record.nextAt : at,
        at,
        at,
      )
      return id
    },

    dueOutbox(at, limit = 20) {
      return sql.dueOutbox.all(at, limit).map(plain)
    },

    getOutbox(id) {
      return plain(sql.getOutbox.get(String(id)))
    },

    markOutboxSent(id) {
      sql.markOutboxSent.run(now(), String(id))
    },

    markOutboxRetry(id, nextAt, error) {
      sql.markOutboxRetry.run(nextAt, error ?? null, now(), String(id))
    },

    markOutboxDead(id, error) {
      sql.markOutboxDead.run(error ?? null, now(), String(id))
    },

    close() {
      try {
        db.close()
      } catch {
        // 关闭失败没有补救手段，也不值得在退出路径上抛错。
      }
    },
  }
}

/**
 * 内存实现 —— 接口与 sqlite 版**逐字相同**，只是不落盘。
 *
 * 刻意不合并成「一个实现 + 可选持久化」：两者的查询语义（排序、`next_at` 比较）
 * 一模一样，但写在一起会让每个方法都多一个 `if (durable)`，而这段代码是崩溃恢复
 * 的关键路径，能少一个分支就少一个。
 *
 * @returns 实现了本模块接口的对象。
 */
function openMemoryStore() {
  /** @type {Map<string, object>} */
  const tickets = new Map()
  /** @type {Map<string, object>} */
  const outbox = new Map()
  const now = () => Date.now()

  const sortByCreated = (a, b) => a.created_at - b.created_at

  return {
    durable: false,
    file: null,

    createTicket(record) {
      const id = typeof record?.id === 'string' && record.id !== '' ? record.id : randomUUID()
      const at = now()
      tickets.set(id, {
        id,
        parent_session: String(record.parentSession),
        parent_request: record.parentRequest ?? null,
        worker_session: null,
        title: String(record.title),
        brief: String(record.brief),
        worker: String(record.worker ?? 'subagent'),
        status: 'queued',
        result: null,
        error: null,
        attempts: 0,
        created_at: at,
        updated_at: at,
        started_at: null,
        finished_at: null,
      })
      return id
    },

    getTicket(id) {
      const row = tickets.get(String(id))
      return row === undefined ? undefined : { ...row }
    },

    listByParent(parentSession) {
      return [...tickets.values()]
        .filter((row) => row.parent_session === String(parentSession))
        .sort((a, b) => b.created_at - a.created_at)
        .map((row) => ({ ...row }))
    },

    listByStatus(status) {
      return [...tickets.values()]
        .filter((row) => row.status === String(status))
        .sort(sortByCreated)
        .map((row) => ({ ...row }))
    },

    listAll(limit = 200) {
      return [...tickets.values()]
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, limit)
        .map((row) => ({ ...row }))
    },

    nextQueued() {
      const row = [...tickets.values()].filter((it) => it.status === 'queued').sort(sortByCreated)[0]
      return row === undefined ? undefined : { ...row }
    },

    countRunning(parentSession) {
      return [...tickets.values()].filter(
        (row) =>
          row.status === 'running' &&
          (parentSession === undefined || row.parent_session === String(parentSession)),
      ).length
    },

    markRunning(id, workerSession) {
      const row = tickets.get(String(id))
      if (row === undefined) return
      const at = now()
      row.status = 'running'
      row.worker_session = workerSession ?? null
      row.started_at = at
      row.updated_at = at
      row.attempts += 1
    },

    markSucceeded(id, result) {
      const row = tickets.get(String(id))
      if (row === undefined) return
      const at = now()
      row.status = 'succeeded'
      row.result = result ?? null
      row.finished_at = at
      row.updated_at = at
    },

    markFailed(id, error) {
      const row = tickets.get(String(id))
      if (row === undefined) return
      const at = now()
      row.status = 'failed'
      row.error = error ?? null
      row.finished_at = at
      row.updated_at = at
    },

    markQueued(id) {
      const row = tickets.get(String(id))
      if (row === undefined) return
      row.status = 'queued'
      row.updated_at = now()
    },

    setStatus(id, status) {
      const row = tickets.get(String(id))
      if (row === undefined) return
      row.status = String(status)
      row.updated_at = now()
    },

    enqueueOutbox(record) {
      const id = typeof record?.id === 'string' && record.id !== '' ? record.id : randomUUID()
      const at = now()
      outbox.set(id, {
        id,
        ticket_id: String(record.ticketId),
        parent_session: String(record.parentSession),
        body: String(record.body),
        state: 'pending',
        attempts: 0,
        next_at: typeof record.nextAt === 'number' ? record.nextAt : at,
        last_error: null,
        created_at: at,
        updated_at: at,
      })
      return id
    },

    dueOutbox(at, limit = 20) {
      return [...outbox.values()]
        .filter((row) => row.state === 'pending' && row.next_at <= at)
        .sort((a, b) => a.next_at - b.next_at)
        .slice(0, limit)
        .map((row) => ({ ...row }))
    },

    getOutbox(id) {
      const row = outbox.get(String(id))
      return row === undefined ? undefined : { ...row }
    },

    markOutboxSent(id) {
      const row = outbox.get(String(id))
      if (row === undefined) return
      row.state = 'sent'
      row.updated_at = now()
    },

    markOutboxRetry(id, nextAt, error) {
      const row = outbox.get(String(id))
      if (row === undefined) return
      row.attempts += 1
      row.next_at = nextAt
      row.last_error = error ?? null
      row.updated_at = now()
    },

    markOutboxDead(id, error) {
      const row = outbox.get(String(id))
      if (row === undefined) return
      row.state = 'dead'
      row.attempts += 1
      row.last_error = error ?? null
      row.updated_at = now()
    },

    close() {
      tickets.clear()
      outbox.clear()
    },
  }
}

/**
 * 打开工单库 —— **本函数永不抛错**。
 *
 * @param options - `{ dir?: string, logger?, warn? }`。
 * @returns `{ store, durable }`；`store` 一定可用。
 */
export function openStore(options = {}) {
  const dir = resolveStateDir(options.dir)
  const warn = typeof options.warn === 'function' ? options.warn : () => {}

  try {
    const store = openSqliteStore({ dir })
    // `file` 必须一起交上去：调用方要拿它打日志、也要在「为什么没持久化」的
    // 告警里指路。早先漏了这一个字段，日志打成 `ticket store ready at undefined`，
    // 排查时看不出工单究竟落在哪个目录。
    return { store, durable: true, file: store.file ?? null }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    // 这条 warn 必须说清「功能全在、只是重启即失忆」，否则用户会以为插件坏了。
    warn(
      `sqlite unavailable (${reason}) — tickets fall back to in-memory storage, ` +
        'so they will not survive a restart',
    )
    return { store: openMemoryStore(), durable: false, file: null }
  }
}

/**
 * 启动恢复：把上次进程遗留的中间状态推到确定的终态。
 *
 * **这是整个 Phase 2 最要紧的一段**，因为它是唯一无法靠「正常流程」覆盖的路径：
 * 用户 ⌘Q 的时候，库里一定躺着若干 `running` 与若干 `queued`。不处理它们，看板就会
 * 永远显示「运行中」，而用户永远等不到结果。
 *
 * 三段判断：
 *
 *   1. `running` 且子会话还活着 → 保持 `running`（宿主会继续跑并通知）。
 *      `running` 但子会话没了 → `failed`，原因写 `session lost on restart`。
 *      查不到（`listChildren` 抛错）→ `orphaned`，**不猜**。
 *   2. 刚被标成终态的工单 → 各排一条 outbox 通知，让用户知道结果。
 *   3. `queued` → 什么都不用做，调度器启动后自然会捞。
 *
 * @param store - `openStore()` 返回的 store。
 * @param options - `{ listChildren, now? }`；`listChildren(parentSession)` 返回子会话 id 数组。
 * @returns `{ kept, lost, orphaned, requeued, notified }` 的统计。
 */
export async function recoverOnBoot(store, options = {}) {
  const listChildren = options.listChildren
  const stats = { kept: 0, lost: 0, orphaned: 0, requeued: 0, notified: 0 }

  const running = store.listByStatus('running')
  for (const ticket of running) {
    const worker = ticket.worker_session
    if (typeof worker !== 'string' || worker === '') {
      // 恰好死在「已标 running 但子会话 id 还没写回」的那一瞬。诚实标 failed。
      store.markFailed(ticket.id, 'ticket was marked running but no child session was recorded')
      stats.lost += 1
      continue
    }
    let alive = undefined
    if (typeof listChildren === 'function') {
      try {
        const children = await listChildren(ticket.parent_session)
        if (Array.isArray(children)) {
          // `subagents.listChildren()` 交回来的是子代理记录（对象），不是裸 id 字符串 ——
          // 两种形状都认，否则每次重启都会把活着的工单误判成「丢失」。
          alive = children.some((child) =>
            typeof child === 'string'
              ? child === worker
              : child !== null && typeof child === 'object' && (child.id === worker || child.sessionId === worker),
          )
        }
      } catch {
        // 宿主还没就绪（或父会话已归档）—— 不猜，标 orphaned。
        alive = undefined
      }
    }
    if (alive === true) {
      stats.kept += 1
      continue
    }
    if (alive === false) {
      store.markFailed(ticket.id, 'session lost on restart')
      stats.lost += 1
    } else {
      store.setStatus(ticket.id, 'orphaned')
      stats.orphaned += 1
    }
    // 状态刚从「运行中」变成终态，用户不会收到宿主的完成通知（那个通知随进程一起
    // 没了），所以这里补一条。
    store.enqueueOutbox({
      ticketId: ticket.id,
      parentSession: ticket.parent_session,
      body:
        alive === false
          ? `工单「${ticket.title}」在重启时丢失了正在运行的子会话，已标记为失败。`
          : `工单「${ticket.title}」在重启后无法确认结果，已标记为待确认。`,
    })
    stats.notified += 1
  }

  // `queued` 不需要迁移：调度器每次 pump 都会重新捞最老的 queued。
  for (const ticket of store.listByStatus('queued')) void ticket.id
  stats.requeued = store.listByStatus('queued').length

  return stats
}
