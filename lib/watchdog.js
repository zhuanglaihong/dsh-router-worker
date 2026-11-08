/**
 * Watchdog —— 给「没崩、没结束、也不再产出」的工单收尾。
 *
 * # 它补的是哪一格
 *
 * runtime.js 已经盖住了两类异常：
 *   · worker 正常跑完 → `session/event` 的 `turn/end` 判 succeeded / failed；
 *   · 进程重启        → `recoverOnBoot` 用 `listChildren` 把失联的 running 标失败。
 *
 * 但有一种情况两个机制都够不到：**子会话还活着（或看起来活着），却不再有任何事件**
 * —— 网络挂起、模型卡死、工具调用僵住、上游流断在半路。`turn/end` 不会来，
 * `agent/disposed` 也不会来，工单会永远挂在 `running`，占着一个并发名额，
 * 后面的 queued 也永远派不出去。Watchdog 就是给这一格兜底的。
 *
 * 文章里它属于「持久自愈」；本插件不做 LLM 判断跑偏（成本不可靠），只做
 * 「静默超时」这一条机械判据。
 *
 * # 为什么是独立的纯模块
 *
 * 和 store / outbox / dispatcher 一样，本文件**不认识宿主**：不 import cordis、
 * 不看 ctx、不碰 DOM。它只通过注入的函数与外界交互，所以可以在任何机器上
 * 用假 store + 假时钟跑单测，不必等 15 分钟，也不必起 Electron。
 * 所有宿主相关的接线都在 `lib/runtime.js`。
 *
 * # 心跳从哪来
 *
 * 判「静默」不能只看工单行的 `updated_at` —— 那列只在状态流转时变，一个正在
 * 流式输出、连续调工具的 worker 一行都不写，15 分钟后照样会被误杀。
 * 所以心跳来自 `session/event`：`runtime.js` 在收到被跟踪子会话的**任意**事件时
 * 调 `touch(sessionId)`，本模块记住最后一次活动时间。
 *
 * 重启后被 `recoverOnBoot` 判定为 kept 的工单，`runtime.js` 会补一次 `touch`，
 * 给它们一个完整的宽限期 —— 否则一张重启前已经跑了 20 分钟的活，会在重启后
 * 第一轮巡检里立刻被判死。
 */

/** 巡检间隔。60 秒足够：阈值是 15 分钟，早一秒晚一秒没有区别。 */
export const WATCHDOG_INTERVAL_MS = 60_000
/** running 静默多久算卡死。 */
export const WATCHDOG_STUCK_MS = 15 * 60_000
/** queued 等多久开始提醒（只告警，不改状态 —— 排队等名额本身是合法的）。 */
export const WATCHDOG_QUEUED_WARN_MS = 30 * 60_000

const STUCK_REASON =
  'no progress for 15 minutes; the worker was interrupted and this ticket was marked failed'
const LOST_REASON = 'worker session disappeared without a turn/end (session lost while running)'

/**
 * @typedef {object} WatchdogOptions
 * @property {object} store                     - store.js 的句柄（`listByStatus` / `markFailed` / `getTicket`）。
 * @property {(ticket: object, body: string) => void} notify - 把结论写进 outbox，送回父会话。
 * @property {(childSessionId: string, parentSessionId: string) => Promise<void>} [interrupt]
 *           中断一个卡住的子会话。抛错不影响判失败。
 * @property {(parentSession: string, childSessionId: string) => Promise<boolean>} [isAlive]
 *           查子会话是否还活着。不提供时按「还活着」处理（仍会尝试中断）。
 * @property {() => number} [now]              - 可注入时钟，测试用。
 * @property {(msg: string) => void} [log]
 * @property {(msg: string) => void} [warn]
 * @property {number} [intervalMs]
 * @property {number} [stuckMs]
 * @property {number} [queuedWarnMs]
 * @property {object} [timer]                  - 宿主的 `ctx.timer`；提供时 `start()` 自己挂定时。
 */

/**
 * 建一个 Watchdog。
 *
 * @param {WatchdogOptions} options
 * @returns {{touch: Function, sweep: Function, start: Function, dispose: Function,
 *            lastActivityOf: Function}}
 */
export function createWatchdog(options) {
  const {
    store,
    notify,
    interrupt,
    isAlive,
    now = () => Date.now(),
    log = () => {},
    warn = () => {},
    intervalMs = WATCHDOG_INTERVAL_MS,
    stuckMs = WATCHDOG_STUCK_MS,
    queuedWarnMs = WATCHDOG_QUEUED_WARN_MS,
    timer,
  } = options

  /** 子会话 id → 最近一次活动时间戳。 */
  const lastActivity = new Map()
  /** 已经提醒过「排队太久」的工单 id，避免每 60 秒刷一条同样的 warn。 */
  const warnedQueued = new Set()

  let closed = false
  /** 共享的 in-flight promise，防止两轮巡检并发时把同一张工单判两次。 */
  let sweeping = null
  let stopTimer

  /**
   * 记一次心跳。`session/event` 里凡是来自被跟踪子会话的事件都调它。
   * 只在字符串非空时记，避免 undefined 变成 Map 的键。
   */
  const touch = (sessionId) => {
    if (typeof sessionId === 'string' && sessionId !== '') lastActivity.set(sessionId, now())
  }

  /** 给测试与看板用的只读视图。 */
  const lastActivityOf = (sessionId) => lastActivity.get(sessionId)

  /**
   * 跑一轮巡检。
   *
   * 三条规则：
   *   1. running 且静默超过 stuckMs → 中断子会话 + `markFailed` + 通知父会话；
   *   2. running 但 `worker_session` 为空 → **跳过**，交给 `recoverOnBoot` 处理，不猜；
   *   3. queued 超过 queuedWarnMs → 只 warn 一次，不改状态。
   *
   * outbox 的「重试 ≥10 次标红」不在本模块：outbox.js 的 `markOutboxDead` 已经做了，
   * 再判一次会重复告警。
   *
   * @returns {Promise<{checked: number, stuck: number, warned: number, healthy: number, skipped: number}>}
   */
  const sweep = () => {
    if (closed) return Promise.resolve({ checked: 0, stuck: 0, warned: 0, healthy: 0, skipped: 0 })
    if (sweeping !== null) return sweeping

    sweeping = (async () => {
      const result = { checked: 0, stuck: 0, warned: 0, healthy: 0, skipped: 0 }
      try {
        const at = now()
        const running = store.listByStatus('running')
        const queued = store.listByStatus('queued')
        result.checked = running.length
        const liveSessions = new Set()

        for (const ticket of running) {
          const sid = ticket.worker_session
          if (typeof sid !== 'string' || sid === '') {
            // 没有子会话 id 的 running 行是异常数据，但**不是** Watchdog 该判的：
            // recoverOnBoot 会把它标成 failed 并写明原因。这里猜只会猜错。
            result.skipped++
            continue
          }
          liveSessions.add(sid)

          const last = lastActivity.get(sid)
          if (last === undefined) {
            // 第一次见到这张工单 —— 最常见于重启后被 `recoverOnBoot` 判定为 kept
            // 的行。以「现在」为心跳起点，给一整个宽限期；绝不能用持久化的
            // `started_at`，那可能是 20 分钟前，会让一张刚恢复、其实还在跑的活
            // 在第一轮巡检里立刻被误杀。本轮只登记、不判。
            lastActivity.set(sid, at)
            result.healthy++
            continue
          }
          const silentFor = at - last
          if (silentFor < stuckMs) {
            result.healthy++
            continue
          }

          // 越过阈值。先问「还活着吗」：活着 → 主动中断；已经没了 → 省掉那次调用。
          let alive = true
          if (typeof isAlive === 'function') {
            try {
              alive = (await isAlive(ticket.parent_session, sid)) === true
            } catch {
              // 查不到不阻塞判失败，按「还活着」处理，顶多多一次注定失败的 interrupt。
              alive = true
            }
          }

          if (alive && typeof interrupt === 'function') {
            try {
              await interrupt(sid, ticket.parent_session)
              log(
                `watchdog interrupted "${ticket.title}" after ${Math.round(silentFor / 60_000)} min of silence ` +
                  '[ROUTER-WATCHDOG-INTERRUPTED]',
              )
            } catch (error) {
              // 中断失败**不改变**判失败的方向：留一张永远 running 的单比误留一个
              // 还在跑的 worker 更糟。只记一条，让排障时知道 interrupt 没生效。
              warn(
                `watchdog could not interrupt "${ticket.title}": ` +
                  `${error instanceof Error ? error.message : String(error)} [ROUTER-WATCHDOG-INTERRUPT-FAILED]`,
              )
            }
          }

          const reason = alive ? STUCK_REASON : LOST_REASON
          store.markFailed(ticket.id, reason)
          lastActivity.delete(sid)
          result.stuck++
          log(`watchdog marked ticket "${ticket.title}" failed: ${reason} [ROUTER-WATCHDOG-FAILED]`)
          notify(
            ticket,
            alive
              ? `工单「${ticket.title}」卡住超过 15 分钟没有进展，已被中断并标记为失败。`
              : `工单「${ticket.title}」的子会话已失联，已标记为失败。`,
          )
        }

        for (const ticket of queued) {
          const waited = at - (ticket.created_at ?? at)
          if (waited >= queuedWarnMs && !warnedQueued.has(ticket.id)) {
            warnedQueued.add(ticket.id)
            result.warned++
            warn(
              `ticket "${ticket.title}" has been queued for ${Math.round(waited / 60_000)} min — ` +
                'still waiting for a free worker slot [ROUTER-WATCHDOG-QUEUED]',
            )
          }
        }

        // 两张表都按「当前还有的」收敛，别让 Map/Set 随会话历史无限长。
        for (const sid of lastActivity.keys()) if (!liveSessions.has(sid)) lastActivity.delete(sid)
        const queuedIds = new Set(queued.map((row) => row.id))
        for (const id of warnedQueued) if (!queuedIds.has(id)) warnedQueued.delete(id)
      } catch (error) {
        // 巡检本身出错不能让定时器的宿主回调炸掉。
        warn(`watchdog sweep failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return result
    })()

    return sweeping.finally(() => {
      sweeping = null
    })
  }

  /** 挂上 60 秒定时。宿主没有 timer 服务时安静降级：仍可手动 sweep（测试/看板用）。 */
  const start = () => {
    if (closed || stopTimer !== undefined) return
    try {
      stopTimer = timer?.interval?.(() => {
        void sweep()
      }, intervalMs)
    } catch {
      stopTimer = undefined
    }
  }

  const dispose = () => {
    if (closed) return
    closed = true
    if (typeof stopTimer === 'function') stopTimer()
    else if (stopTimer !== undefined && typeof stopTimer.dispose === 'function') stopTimer.dispose()
    lastActivity.clear()
    warnedQueued.clear()
  }

  return { touch, sweep, start, dispose, lastActivityOf }
}

export { STUCK_REASON, LOST_REASON }
