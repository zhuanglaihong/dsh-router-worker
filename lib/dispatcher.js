/**
 * dispatcher — 工单队列的消费者。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 宿主对并发名额的态度是**明确拒绝而不是排队**。原文（`startActivation` 的契约注释）：
 *
 *     At capacity, creation or cold resume rejects with ACTIVATION_LIMIT_REACHED
 *     (browser prompts receive subagent/delivery-unavailable): wait for a child
 *     to finish… Admission does not queue.
 *
 * 也就是说，用户一口气给十张工单，第 9、10 张会直接拿到一个 `ACTIVATION_LIMIT_REACHED`
 * 错误。如果 `ticket_create` 把它原样抛回去，协调者会看到「派活失败」并试图自己重试
 * —— 而它没有「等一个名额空出来」的能力，于是只能把活塞回自己的上下文或者干脆放弃。
 * 这正是「多任务」崩塌的地方。
 *
 * 所以本模块的唯一职责是：**把宿主的拒绝翻译成排队**。工单先落库为 `queued`，再由
 * 调度器按名额一张一张放出去。
 *
 * ── 为什么不自己算名额 ───────────────────────────────────────────────────────
 *
 * `subagent.maxActiveSubagents` 是宿主配置（默认 8），但它的**计数口径我们看不到**：
 * 它算的是「这一个主 Agent 下所有活着的 Subagent」，既包含我们派的，也包含用户或别的
 * 插件派的；而且名额是 process-local 的，每次新建/冷恢复前重新采样。
 *
 * 自己去读那个配置再数一遍，等于维护第二本账 —— 两本账迟早不一致（本项目在并发上限上
 * 已经踩过一次：上游插件曾有一个自己的上限字段，与宿主那个同时生效、谁先拒绝取决于
 * 运行时细节，最后被删除）。所以这里**不做预算，只做反应**：
 *
 *     尝试派 → 成功就继续 → 撞到名额拒绝就退回 queued，等下一次 pump
 *
 * 好处是它天然正确：不管名额是 1 还是 8，不管中间有没有别人派活，我们的行为都对。
 * 代价是「一次 pump 里会白撞一次失败」，可忽略不计（那是一次同步抛错，不发网络请求）。
 *
 * ── 语义边界 ─────────────────────────────────────────────────────────────────
 *
 * 只处理**本进程**创建、且**本父会话**的工单。跨进程不做（那需要分布式锁，本项目
 * 明确不做，见计划的「明确不做」一节）。
 *
 * @module dsh-subagent-tree/lib/dispatcher
 */

/**
 * 从错误对象里判断「是不是名额满了」。
 *
 * 宿主的错误码是 `ACTIVATION_LIMIT_REACHED`，但把它暴露成 `error.code` 还是塞在
 * `error.message` 里取决于调用路径（本地 provider 与浏览器 prompt 走的路不同）。
 * 这里两种都认，且**只**认这一个码 —— 把别的错误误判成「满了」会让工单无限排队而
 * 永远不失败，那比直接报错更难查。
 *
 * @param error - 捕获到的异常。
 * @returns 是否为名额拒绝。
 */
export function isCapacityError(error) {
  if (error === undefined || error === null) return false
  const code = typeof error.code === 'string' ? error.code : ''
  if (code === 'ACTIVATION_LIMIT_REACHED' || code === 'subagent/delivery-unavailable') return true
  const message = error instanceof Error ? error.message : String(error)
  // 只匹配这两个码的**原文**，不匹配「limit」这种泛词 —— 后者会把
  // 「limit must be less than or equal to 2000」这种完全无关的错误也算进来。
  return (
    message.includes('ACTIVATION_LIMIT_REACHED') ||
    message.includes('subagent/delivery-unavailable')
  )
}

/**
 * 创建一个调度器。
 *
 * @param options - 见下面的解构。
 * @returns `{ start, pump, wake, dispose, pending }`。
 */
export function createDispatcher(options) {
  const store = options.store
  const startActivation = options.startActivation
  const resolveMaxDepth = options.resolveMaxDepth
  const outbox = options.outbox
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const log = typeof options.log === 'function' ? options.log : () => {}
  const warn = typeof options.warn === 'function' ? options.warn : () => {}

  /** 正在派发的工单 id 集合 —— 防止两次 pump 并发地派出同一张工单。 */
  const inFlight = new Set()
  /** 防重入的 pump promise。 */
  let pumping = null
  /** 卸载标志。 */
  let closed = false

  /**
   * 派发一张工单。
   *
   * @param ticket - store 里的一行。
   * @returns `'dispatched'` / `'queued'`（名额不够）/ `'failed'`。
   */
  async function dispatchOne(ticket) {
    if (inFlight.has(ticket.id)) return 'queued'
    inFlight.add(ticket.id)
    try {
      const request = { prompt: [{ type: 'text', text: ticket.brief }] }
      if (typeof resolveMaxDepth === 'function') {
        try {
          const maxDepth = resolveMaxDepth(1)
          if (maxDepth !== undefined) request.maxDepth = maxDepth
        } catch {
          // 解析不了就不带，让服务用它自己的默认值。
        }
      }

      let activation
      try {
        activation = await startActivation({
          provider: ticket.worker_provider,
          // ★ 短名直接当 label：这是侧栏子对话树读的那个字段。
          label: ticket.title,
          request,
          delivery: 'parent',
        })
      } catch (error) {
        if (isCapacityError(error)) {
          // 名额不够 —— 这是**预期**，不是失败。工单留在 queued，等下一次 pump。
          return 'queued'
        }
        const message = error instanceof Error ? error.message : String(error)
        store.markFailed(ticket.id, `dispatch failed: ${message}`)
        log(`dsh-subagent-tree: ticket "${ticket.title}" dispatch failed: ${message} [ROUTER-DISPATCH-FAILED]`)
        return 'failed'
      }

      const childId = typeof activation?.childId === 'string' ? activation.childId : undefined
      if (childId === undefined) {
        store.markFailed(ticket.id, 'dispatching returned no child session id')
        log(`dsh-subagent-tree: ticket "${ticket.title}" got no child id [ROUTER-DISPATCH-FAILED]`)
        return 'failed'
      }

      store.markRunning(ticket.id, childId)
      log(
        `dsh-subagent-tree: ticket "${ticket.title}" (${ticket.worker}) running as ${childId} [ROUTER-DISPATCH-STARTED]`,
      )
      return 'dispatched'
    } finally {
      inFlight.delete(ticket.id)
    }
  }

  /**
   * 抽一轮队列。
   *
   * 每轮只派一张排队最久的工单，然后**重新**取下一张。这个「一次一张」的形状是刻意的：
   * 派完一张之后名额状态变了，继续按旧快照派就会连着撞墙；重新取一张的成本是一次
   * 索引查询，可以忽略。
   *
   * 停在三种情况：没有 queued 了 / 撞到名额 / 派发失败（失败的不该阻塞后面的）。
   *
   * @param limit - 最多派几张（防止一次 pump 吃太久）。
   * @returns `{ dispatched, failed, capacity }`。
   */
  async function pumpOnce(limit = 8) {
    const stats = { dispatched: 0, failed: 0, capacity: false }
    if (closed) return stats

    for (let index = 0; index < limit; index += 1) {
      if (closed) break
      const ticket = pickNext()
      if (ticket === undefined) break
      const outcome = await dispatchOne(ticket)
      if (outcome === 'dispatched') {
        stats.dispatched += 1
        continue
      }
      if (outcome === 'failed') {
        stats.failed += 1
        continue
      }
      // 名额不够：立刻停手。继续试只会连着撞同一堵墙。
      stats.capacity = true
      break
    }
    return stats
  }

  /**
   * 取下一张该派的工单。
   *
   * `worker_provider` 是 `ticket_create` 写进 `worker` 列的类型键（`subagent` /
   * `subagent_minimal` / …），这里映射成 provider 名。映射表刻意与
   * `ticket-create.mjs`、`composition.mjs` 保持一致的三份之一 —— 三处都能改错，
   * 但只有这里错了会导致「工单派不出去」，所以错得最响。
   *
   * @returns 带 `worker_provider` 的工单行，或 undefined。
   */
  function pickNext() {
    const row = store.nextQueued()
    if (row === undefined) return undefined
    return { ...row, worker_provider: providerOf(row.worker) }
  }

  /**
   * 防重入的泵。
   *
   * @param limit - 最多派几张。
   * @returns 统计。
   */
  function pump(limit = 8) {
    if (closed) return Promise.resolve({ dispatched: 0, failed: 0, capacity: false })
    if (pumping !== null) return pumping
    pumping = pumpOnce(limit).finally(() => {
      pumping = null
    })
    return pumping
  }

  /**
   * 「有事可做了」的信号。
   *
   * 调用点有三处：新工单入队、子代理结束（名额腾出来一个）、定时器兜底。它只是触发
   * 一次 pump，不做排队 —— 因为 pump 自身已经是幂等的，重复触发没有副作用。
   *
   * @returns 统计。
   */
  function wake() {
    return pump()
  }

  /** 卸载。 */
  function dispose() {
    closed = true
  }

  /** 当前排队中的数量（看板与日志用）。 */
  function pending() {
    return store.listByStatus('queued').length
  }

  return { start: dispatchOne, pump, wake, dispose, pending }
}

/**
 * worker 类型键 → provider 名。
 *
 * ⚠️ 必须与 `presets/router-worker/ticket-create.mjs` 的 `WORKER_PROVIDERS` 和
 * `composition.mjs` 的 `WORKER_PROVIDERS` **逐字一致**。三份各自保留而不是互相
 * import，是为了守住「子模块零相对 import」的约定（相对 import 不继承入口的 `?v=N`
 * query，改了文本会取回旧模块且不报错 —— 这个坑本项目已经踩过）。
 *
 * @param workerType - 工单的 `worker` 列。
 * @returns provider 名。
 */
export function providerOf(workerType) {
  switch (workerType) {
    case 'subagent_fork':
      return 'fork'
    case 'subagent_ptc':
      return 'router_worker_ptc'
    case 'subagent_minimal':
      return 'router_worker_minimal'
    default:
      return 'spawn'
  }
}
