/**
 * router-worker-runtime — 把 store / outbox / dispatcher 接到宿主服务上。
 *
 * ── 它补的是哪几个洞 ──────────────────────────────────────────────────────────
 *
 * Phase 1 的 `ticket_create` 是「起名 + 立刻派发」。它有三个洞，全部来自**宿主
 * 明确不负责**的部分：
 *
 *   1. **宿主不排队**。`startActivation` 在名额用完时直接拒绝
 *      （`ACTIVATION_LIMIT_REACHED`），原文写着 “Admission does not queue”。所以
 *      一次派三张、而上限是 1 时，第二三张必须由**我们**记住并在名额释放后补派。
 *   2. **进程一退出，工单就忘了**。Phase 1 的工单表是进程内 Map，`⌘Q` 之后
 *      谁在跑、跑到哪、结果有没有送到，全部无从得知。
 *   3. **结果送达是「尽力而为」**。`delivery: 'parent'` 让宿主在子代理结束时给
 *      父会话发一条完成通知 —— 但如果那一刻父会话不在回合中、或应用刚重启，
 *      这条通知就没有落点。落表 + 退避重投才有「一定送到」。
 *
 * ── 为什么不自己数并发名额 ────────────────────────────────────────────────────
 *
 * `subagent.maxActiveSubagents` 的口径我们把不住：它是 process-local 的，包含
 * **别的插件**派的活，且每次新建/冷恢复前重新采样。自己维护一个预算表等于维护
 * 第二本账，两本账一旦不一致就会出现「我们以为还有名额、宿主却拒绝」——
 * 上游某个插件正因此同时叠了两个上限出过事故并被删掉。
 *
 * 所以这里的策略是**只对拒绝作反应**：撞到名额错误就把工单留在 `queued`，
 * 等下一个信号（子代理结束 / 定时器）再试。详见 `dispatcher.js` 文件头。
 *
 * ── 结果回流的两条通道 ────────────────────────────────────────────────────────
 *
 * 正常运行时不发 outbox：宿主自己的完成通知已经把结果送到父会话了，我们再发一遍
 * 就是重复。outbox 只在**宿主送不到**的场景启用 —— 目前就是重启恢复：
 *
 *   - 重启后发现某张 `running` 的子会话已经不在了 → 标记 `failed` + 说明原因，
 *     并投一条「这张活丢了」的通知，让人知道要重跑；
 *   - 重启后发现子会话还在（应用重开而子代理的会话仍被宿主认领）→ 标 `orphaned`，
 *     不投通知、也不猜结果 —— 猜成失败会让人去重跑一个其实还活着的活。
 *
 * 判定工单完成用的是 `session/event` 上的 `turn/end`，不是轮询：子代理每跑完一轮
 * 宿主都会发这个事件（`dsh-better-sidebar` 就是用它判失败的，见其
 * `client-registry.js` 的 `failureText`）。失败文本的两种形状也照它的写法取
 * ——`reason.error.message`（agent loop 的）和 `reason.failure.message`
 * （dsh-llm 的 adapterFailureChunk）。
 *
 * @module dsh-subagent-tree/lib/runtime
 */

import { createDispatcher, providerOf, isCapacityError } from './dispatcher.js'
import { createOutbox } from './outbox.js'
import { openStore, recoverOnBoot } from './store.js'
import { createWatchdog } from './watchdog.js'

/** 派单泵与投递泵的间隔：够快让人感觉是「立刻」，又不至于空转。 */
const TICK_MS = 2_000

/**
 * 运行时句柄在 `globalThis` 上的键。
 *
 * ── 为什么走全局而不是 `ctx.provide` ─────────────────────────────────────────
 *
 * 本模块装在**宿主平面**，而用它的 `ticket_create` 装在**preset 内部**。那是两个
 * 不同的 cordis context，服务可见性要顺着挂载树传下来 —— 而 preset 的 plugins
 * 由 `agentPresets.register(definition)` 在注册表自己的挂载点上组装，那条路是不是
 * 本 ctx 的后代并不由我们决定（换个 DSH 版本就可能变）。
 *
 * `Symbol.for` 是**进程级**的同一份符号，两边拿到的一定是同一个键，不受挂载树
 * 与 `?v=N` 缓存键影响（`ticket-create.mjs` 被 composition 的 `local()` 带上
 * query 导入，模块实例与本文件可能不是同一个，但它们共享同一个 `globalThis`）。
 *
 * 代价：同一进程里装两份本插件会互相覆盖 —— 但那本来就不该发生，且
 * `index.js` 的 `mounted` WeakSet 已经在拦重复挂载。
 */
export const RUNTIME_KEY = Symbol.for('dsh-subagent-tree.router-runtime')

/** 结果文本进 outbox 时的截断长度 —— 通知是给人看的摘要，不是全文搬运。 */
const RESULT_MAX_CHARS = 600

/**
 * 取 `turn/end` 里那条失败原因的可读文本。
 *
 * 与 `dsh-better-sidebar/lib/client-registry.js` 的 `failureText` 同源规则：
 * 只有 `kind === 'error'` 才算失败，消息可能在 `reason.error.message` 或
 * `reason.failure.message`，两处都没有就退回 `String(reason)`，保证行不为空。
 *
 * @param reason - `turn/end` 事件里的 `data.reason`。
 * @returns 失败说明；不是失败则 undefined。
 */
function failureText(reason) {
  if (reason === null || typeof reason !== 'object' || Array.isArray(reason)) return undefined
  if (reason.kind !== 'error') return undefined
  for (const candidate of [reason.error, reason.failure]) {
    if (candidate === null || typeof candidate !== 'object') continue
    if (typeof candidate.message === 'string' && candidate.message !== '') return candidate.message
  }
  return String(reason)
}

/**
 * 从一条 `assistant/message` 事件里抽正文。
 *
 * @param message - `data.message`。
 * @returns 拼好的文本；没有文本块则空串。
 */
function messageText(message) {
  if (message === null || typeof message !== 'object') return ''
  const content = Array.isArray(message.content) ? message.content : []
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 把字符串截到指定长度，超出补省略号。
 *
 * @param text - 原文。
 * @param max - 上限（按 code point 计）。
 * @returns 截断后的文本。
 */
function clip(text, max) {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

/**
 * 装载调度运行时。
 *
 * 返回的对象里 `enqueue` / `wake` 给 `ticket_create` 用，`dispose` 给卸载用。
 * 任何一步失败都**不抛**：拿不到 store 就退化成内存版，拿不到子代理服务就只
 * 记录不发，本插件的主功能（侧栏树）绝不受影响。
 *
 * @param ctx - 宿主平面的插件上下文。
 * @param options - `{ enabled, stateDir, logger }`。
 * @returns 运行时句柄。
 */
export function installRuntime(ctx, options = {}) {
  const log = (message) => ctx.logger?.info?.(`dsh-subagent-tree: ${message}`)
  const warn = (message) => ctx.logger?.warn?.(`dsh-subagent-tree: ${message}`)

  if (options.enabled === false) {
    log('runtime disabled by configuration; tickets stay in memory and results are not tracked')
    return undefined
  }

  const opened = openStore({ dir: options.stateDir, logger: ctx.logger })
  const store = opened.store
  if (opened.durable !== true) {
    warn(
      'tickets are NOT durable on this machine (sqlite could not be opened) — after a restart, ' +
        'running tickets cannot be recovered and queued tickets are lost',
    )
  } else {
    log(`ticket store ready at ${opened.file}`)
  }

  /**
   * 子会话 id → 工单。重建自 `running` 行，派发成功后补进来。
   *
   * 刻意不落一张映射表：`worker_session` 列本来就是那条映射，只是反查要多扫几行。
   * `running` 的行数等于当前在跑的并发数（个位数），扫一遍比多一张表、多一次
   * 写事务更划算。
   */
  const byWorkerSession = new Map()

  const remember = (ticketId, workerSession) => {
    if (typeof workerSession === 'string' && workerSession !== '') byWorkerSession.set(workerSession, ticketId)
  }

  const forget = (ticketId) => {
    for (const [workerSession, id] of byWorkerSession) if (id === ticketId) byWorkerSession.delete(workerSession)
  }

  /** 子会话最近一条 assistant 正文 —— 结果通知的摘要来源。 */
  const lastText = new Map()

  // ── 恢复：把重启前留下的 running 账单算清 ────────────────────────────────────
  //
  // 这一步必须早于第一个泵，否则泵会把「其实还活着」的工单当成新活再派一遍。
  // 所以这里把 promise 留下来，`pump()` 会先 await 它（见下面 `pump` 的定义）。
  const recovered = (async () => {
    try {
      const subagents = serviceOf('subagents')
      const report = await recoverOnBoot(store, {
        listChildren:
          subagents !== undefined && typeof subagents.listChildren === 'function'
            ? (parentSession) => subagents.listChildren(parentSession)
            : undefined,
        logger: ctx.logger,
      })
      if (report.kept + report.lost + report.orphaned + report.requeued > 0) {
        log(
          `recovered tickets after restart: kept ${report.kept}, lost ${report.lost}, ` +
            `orphaned ${report.orphaned}, requeued ${report.requeued} [ROUTER-RUNTIME-RECOVERED]`,
        )
      }
      for (const row of store.listByStatus('running')) {
        remember(row.id, row.worker_session)
        // 被判 kept 的工单在重启前可能已经跑了 20 分钟，心跳表却是空的：给它们
        // 一个从「现在」起算的完整宽限期，否则第一轮巡检就会把还在跑的活误杀。
        // `watchdog` 在本函数体更下方用 const 声明，但这里处在 await 之后的
        // microtask 里，届时整个同步函数体（含那条声明）早已执行完。
        watchdog.touch(row.worker_session)
      }
      // 恢复过程本身可能产生待送通知（例如「工单在重启时丢失」）。立刻投一次，
      // 别让用户等下一个 2 秒节拍。
      if (report.notified > 0) void outbox.pump().catch(() => {})
    } catch (error) {
      warn(`recovering tickets failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()

  /**
   * 取一个宿主服务。
   *
   * 用 `ctx.get` 而不是 `ctx.<name>`：后者对被声明为受控属性的服务会抛
   * `cannot get property "…" without inject`（本项目在 `ctx.document` 上踩过一次，
   * 那次直接让渲染进程起不来）。`get` 抛错也在这里吃掉，调用方只看得到 undefined。
   *
   * @param name - 服务名。
   * @returns 服务实例，或 undefined。
   */
  function serviceOf(name) {
    try {
      const service = ctx.get?.(name)
      return service === undefined || service === null ? undefined : service
    } catch {
      return undefined
    }
  }

  // ── outbox：只在宿主送不到的场景投递 ────────────────────────────────────────
  const outbox = createOutbox({
    store,
    warn,
    deliver: async (row) => {
      const sessions = serviceOf('sessions')
      if (sessions === undefined || typeof sessions.prompt !== 'function') {
        throw new Error('the sessions service is unavailable, so the result cannot be delivered')
      }
      // `queue` 而不是 `steer`：这条通知可能在退避几分钟后才送到，那时父会话
      // 正在跑的那一步与这张工单毫无关系，按 steer 插进去就是捣乱。
      await sessions.prompt(row.parent_session, row.id, row.body, 'queue')
    },
  })

  // ── dispatcher：把 queued 的工单在名额允许时派出去 ──────────────────────────
  const dispatcher = createDispatcher({
    store,
    outbox,
    log,
    warn,
    resolveMaxDepth: (configured) => {
      const subagents = serviceOf('subagents')
      return typeof subagents?.resolveMaxDepth === 'function' ? subagents.resolveMaxDepth(configured) : configured
    },
    startActivation: async (spec) => {
      const subagents = serviceOf('subagents')
      if (subagents === undefined || typeof subagents.startActivation !== 'function') {
        throw new Error('the subagent service is unavailable, so the ticket cannot be dispatched')
      }
      const activation = await subagents.startActivation(spec)
      return activation
    },
  })

  // 派发成功后立刻把 `worker_session → ticket` 记下来，好在 `turn/end` 时反查。
  // 放在一个包裹里而不是改 dispatcher：dispatcher 是纯逻辑模块，不认识宿主事件。
  const pump = async () => {
    // 恢复没跑完就派活的话，一张「其实还活着」的工单可能被重复派出去 ——
    // 等它落地（正常是几十毫秒，且只等一次）。
    try {
      await recovered
    } catch {
      // 恢复自己已经 warn 过；这里不能让一颗坏掉的恢复把泵也拖死。
    }
    const before = new Set(store.listByStatus('running').map((row) => row.id))
    const stats = await dispatcher.pump()
    if (stats.dispatched > 0) {
      for (const row of store.listByStatus('running')) if (!before.has(row.id)) remember(row.id, row.worker_session)
    }
    return stats
  }

  // ── 结果回流：写进 outbox，由投递泵送回父会话 ────────────────────────────────
  //
  // 宿主在 `delivery: 'parent'` 时**自己**也会发一条面向模型的完成通知，所以正常
  // 情况下用户已经能看到子代理的结论。outbox 补的是它补不了的两件事：
  //   · 进程重启后——宿主那条通知随进程没了；
  //   · 父会话当时不在回合中——通知会落在空处。
  // 因此这里的文案刻意写得**像给人看的摘要**（带工单名），而不是「又一条模型消息」；
  // 重复一次总比丢了强。
  const notify = (ticket, body) => {
    const parentSession = ticket.parent_session
    if (typeof parentSession !== 'string' || parentSession === '') return
    outbox.enqueue({ ticketId: ticket.id, parentSession, body })
    // 立刻拉一次投递泵：否则要等下一个 2 秒兜底节拍，用户会觉得「结果迟迟不回来」。
    void outbox.pump().catch(() => {})
  }

  // ── Watchdog：给「没崩、没结束、也不再产出」的工单收尾 ───────────────────────
  //
  // `turn/end` 盖正常结束、`recoverOnBoot` 盖重启，剩下的空格是：子会话还活着
  // 却不再发任何事件（网络挂起 / 模型卡死 / 工具僵住）。那种工单会永远挂在
  // running，占住一个并发名额，后面 queued 也永远派不出去。
  //
  // 纯逻辑在 lib/watchdog.js，这里只负责三件宿主相关的事：心跳（下面的
  // session/event 监听里调 touch）、中断（interrupt）、查存活（isAlive）。
  const watchdog = createWatchdog({
    store,
    notify,
    now: () => Date.now(),
    log,
    warn,
    timer: ctx.timer,
    // 用「持久父地址」形式的 authority：Watchdog 跑在宿主平面，手上没有那个
    // 父会话的 live Agent 对象，`kind:'ancestor'` 要求精确 live agent，拿不到。
    // `{kind:'user', parentSessionId}` 只需 durable id，正是 `interruptByParent`
    // 内部使用的形状（asar 104673015 可查）。
    interrupt: async (childSessionId, parentSessionId) => {
      const subagents = serviceOf('subagents')
      if (subagents === undefined) throw new Error('subagent service unavailable')
      if (typeof subagents.interruptByParent === 'function') {
        await subagents.interruptByParent(childSessionId, parentSessionId, 'continuable')
        return
      }
      if (typeof subagents.interrupt === 'function') {
        subagents.interrupt(childSessionId, { kind: 'user', parentSessionId })
        return
      }
      throw new Error('subagent service exposes no interrupt capability')
    },
    // 判「还活着吗」：宿主 listChildren 交回来的可能是字符串也可能是对象
    // （recoverOnBoot 踩过这个坑），两种都认。查不出来一律按「还活着」处理，
    // 顶多多一次注定空转的 interrupt，不影响判失败的方向。
    isAlive: async (parentSession, childSessionId) => {
      const subagents = serviceOf('subagents')
      if (subagents === undefined || typeof subagents.listChildren !== 'function') return true
      const children = await subagents.listChildren(parentSession)
      if (!Array.isArray(children)) return true
      return children.some((child) =>
        typeof child === 'string'
          ? child === childSessionId
          : child?.id === childSessionId || child?.sessionId === childSessionId,
      )
    },
  })
  watchdog.start()

  // ── 完成判定：订阅子会话的 turn/end ─────────────────────────────────────────
  //
  // 不用轮询：子代理每跑完一轮宿主都发这个事件，轮询只能靠「看起来没动静了」
  // 猜，猜早了会把还在跑的活标成功。
  const offEvent = (() => {
    try {
      return ctx.on('session/event', (session, event) => {
        try {
          const sessionId = typeof session?.id === 'string' ? session.id : undefined
          if (sessionId === undefined) return
          const type = event?.type
          const data = event?.data

          // 心跳：只要这个子会话还有任何事件，就说明它没卡住。必须在下面所有
          // return 之前调 —— 否则一个只流式输出、迟迟不 `turn/end` 的 worker
          // 会被 15 分钟后误杀。只对「被跟踪的子会话」记，主会话的事件不进来。
          if (byWorkerSession.has(sessionId)) watchdog.touch(sessionId)

          if (type === 'assistant/message') {
            const text = messageText(data?.message)
            if (text !== '') lastText.set(sessionId, text)
            return
          }
          if (type !== 'turn/end') return

          const ticketId = byWorkerSession.get(sessionId)
          if (ticketId === undefined) return
          const ticket = store.getTicket(ticketId)
          // 已经有终态就不再改写：continuable 的 worker 可能被续接，第二轮结束时
          // 这张工单早成功了，第二次 turn/end 不该把它改成别的结论。
          if (ticket === undefined || ticket.status !== 'running') return

          const failure = failureText(data?.reason)
          if (failure !== undefined) {
            store.markFailed(ticketId, failure)
            forget(ticketId)
            log(`ticket "${ticket.title}" failed: ${clip(failure, 200)} [ROUTER-TICKET-FAILED]`)
            notify(ticket, `工单「${ticket.title}」失败了：${clip(failure, 300)}`)
            return
          }

          const summary = clip(lastText.get(sessionId) ?? '', RESULT_MAX_CHARS)
          lastText.delete(sessionId)
          store.markSucceeded(ticketId, summary)
          forget(ticketId)
          log(`ticket "${ticket.title}" succeeded [ROUTER-TICKET-SUCCEEDED]`)
          notify(ticket, `工单「${ticket.title}」完成了：\n\n${summary === '' ? '（子代理没有留下文字结论）' : summary}`)
        } catch (error) {
          // 监听器抛错会打断宿主的 Session 发布循环 —— 这里的失败必须自己吞掉。
          warn(`ticket bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    } catch {
      // 极简 context 没有 `on`：工单仍能派发，只是完成状态不会落库。
      return undefined
    }
  })()

  // ── 两个泵：一个派活，一个投递 ───────────────────────────────────────────────
  //
  // 定时器是**兜底**，不是主通道：新工单入队时、子代理结束时都会主动 wake 一次。
  // 兜底值不值得设？值得 —— 名额是别的插件也会释放的资源，我们不订阅它。
  let timer
  try {
    timer = ctx.timer?.interval?.(() => {
      void pump().catch(() => {})
      void outbox.pump().catch(() => {})
    }, TICK_MS)
  } catch {
    timer = undefined
  }

  // 子代理结束时名额腾出来一个，立刻补派；顺带把投递泵拉一下，省一次等待。
  const offAgent = (() => {
    try {
      return ctx.on('agent/disposed', () => {
        void pump().catch(() => {})
      })
    } catch {
      return undefined
    }
  })()

  // 卸载。
  let closed = false
  const dispose = () => {
    if (closed) return
    closed = true
    dispatcher.dispose()
    outbox.dispose()
    watchdog.dispose()
    for (const off of [offEvent, offAgent]) if (typeof off === 'function') off()
    if (typeof timer === 'function') timer()
    else if (timer !== undefined && typeof timer.dispose === 'function') timer.dispose()
    store.close()
  }

  /**
   * 开一张工单 —— `ticket_create` 的落库入口，派发由泵负责。
   *
   * @param record - `{ title, brief, worker, parentSession, parentRequest }`。
   * @returns `{ ok, ticketId, message }`。
   */
  const enqueue = (record) => {
    const ticketId = store.createTicket(record)
    // 立刻拉一次泵：多数情况下名额是够的，工单应当在同一个回合内就派出去，
    // 等两秒的定时器才动手会让人觉得「派单没反应」。
    void pump().catch(() => {})
    return { ok: true, ticketId, message: `Opened ticket "${record.title}" (${record.worker}); it is queued and will start as soon as a worker slot is free.` }
  }

  /**
   * 对外句柄。`ticket_create` 通过 `globalThis[RUNTIME_KEY]` 拿到的就是它
   * （为什么要走全局键，见本文件顶部 `RUNTIME_KEY` 的注释）。
   */
  const handle = {
    store,
    durable: opened.durable === true,
    file: opened.file ?? null,
    enqueue,
    pump,
    wake: () => void pump().catch(() => {}),
    list: (parentSession) =>
      typeof parentSession === 'string' && parentSession !== ''
        ? store.listByParent(parentSession)
        : store.listAll(),
    cancel(ticketId) {
      const ticket = store.getTicket(ticketId)
      if (ticket === undefined) return { ok: false, message: `No ticket "${ticketId}".` }
      if (ticket.status !== 'queued' && ticket.status !== 'running') {
        return { ok: false, message: `Ticket "${ticket.title}" is already ${ticket.status}.` }
      }
      store.setStatus(ticketId, 'cancelled')
      forget(ticketId)
      return { ok: true, message: `Cancelled ticket "${ticket.title}".` }
    },
    dispose,
  }

  // 登记到进程级全局键：`ticket-create.mjs` 在 preset 内部的另一个 context 里，
  // 拿不到本 ctx 的服务，只能从这里取。关闭时摘掉 —— 但只在还是自己那份时才摘，
  // 否则会把热替换后新实例登记的那份误删（表现是「重载后工单再也派不出去」）。
  globalThis[RUNTIME_KEY] = handle
  const unregister = dispose
  const wrappedDispose = () => {
    if (globalThis[RUNTIME_KEY] === handle) delete globalThis[RUNTIME_KEY]
    unregister()
  }
  handle.dispose = wrappedDispose

  return handle
}
export { providerOf, isCapacityError, failureText }
