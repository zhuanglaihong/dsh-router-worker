/**
 * outbox — 把「结果通知」当成一个带重试的投递任务，而不是一次 `await`。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 宿主在 `startActivation({ delivery: 'parent' })` 之后**会**自动发一条完成通知给父
 * 会话。所以「子代理干完活，Router 知道」这件事本来就有，不需要我们做。
 *
 * 真正没有的是两种时刻：
 *
 *   1. **重启后的补投**。⌘Q 的时候子代理已经跑完，但通知还在飞行途中 —— 它随进程
 *      一起消失了。重启后没有任何人重发。
 *   2. **父会话不在回合中**。宿主那条通知是「面向模型的」，它挂在父 Agent 的下一
 *      轮里。如果父 Agent 此刻没有回合在跑（用户走开了、或者它在等某个阻塞工具），
 *      通知就只能排队等 —— 而如果那个等待本身也随重启没了，通知就永远送不出去。
 *
 * 所以本模块把「送一条结果通知」写进 `outbox` 表，由一个定时泵按退避梯子重试。
 * 表里每一行是**一条待送的通知**，送成功就 `sent`，试满 10 次就 `dead`。
 *
 * ── 为什么投递是这个形状（`queue` 而不是 `steer`）────────────────────────────
 *
 * `sessions.prompt(sessionId, requestId, text, mode)` 有两种模式：
 *
 *   `steer` —— 插进当前步的就近位置。适合**用户**中途插话（他要立刻改变方向）。
 *   `queue` —— 排到下一个回合。适合**后台结果**（它不该打断用户正在看的那一轮）。
 *
 * outbox 永远用 `queue`。理由是重试语义：一条退避 5 分钟后才送到的通知，如果按
 * `steer` 插进去，会插进**届时**正在跑的那一步 —— 那一步跟这张工单毫无关系，插进去
 * 就是捣乱。`queue` 至少保证「排在末尾，按时间顺序读下来是连贯的」。
 *
 * ── 为什么投递函数是注入的 ───────────────────────────────────────────────────
 *
 * 送消息要用宿主服务（`sessions` / `parent.followup`），而拿这些服务的时机与拿不到时
 * 的降级策略属于上层（`index.js` / `dispatcher.js`）的知识。本模块只负责「什么时候
 * 送、送几次、失败怎么退避」，把「怎么送」收成一个 `deliver(row)` 回调 —— 这样
 * 泵可以脱离宿主单独测（本仓库的 `_probe_outbox.mjs` 就是这么做的）。
 *
 * @module dsh-router-worker/lib/outbox
 */

import { OUTBOX_BACKOFF_MS, OUTBOX_MAX_ATTEMPTS } from './store.js'

/**
 * 第 n 次失败之后该等多久。
 *
 * 刻意用「次数」而不是「上次等待 ×2」来算：梯子是显式写死的（1s / 5s / 30s / 5min），
 * 指数退避在只有四档的时候反而更难读，而且会让「第 3 次失败」的等待时间取决于前两次
 * 各自等了多久 —— 一旦某次因为进程睡了很久而变长，后面所有等待都会被拖长。
 *
 * @param attempts - 已经失败的次数（≥1）。
 * @returns 毫秒。
 */
export function backoffFor(attempts) {
  const index = Math.max(0, Math.min(OUTBOX_BACKOFF_MS.length - 1, attempts - 1))
  return OUTBOX_BACKOFF_MS[index]
}

/**
 * 创建一个 outbox 泵。
 *
 * @param options - `{ store, deliver, now?, warn? }`。
 *   `deliver(row)` 返回 Promise；resolve 即视为送出，reject 则进入退避。
 * @returns `{ enqueue, pump, drain, dispose }`。
 */
export function createOutbox(options) {
  const store = options.store
  const deliver = options.deliver
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const warn = typeof options.warn === 'function' ? options.warn : () => {}

  /** 防重入：泵在跑的时候再来一次直接返回，避免同一条通知被两个并发 pump 各送一次。 */
  let pumping = null
  /** 卸载标志：置位后泵不再触碰 store（store 可能已经 close）。 */
  let closed = false

  /**
   * 登记一条待送通知。
   *
   * @param record - `{ ticketId, parentSession, body, nextAt? }`。
   * @returns outbox 行 id。
   */
  function enqueue(record) {
    if (closed) return undefined
    return store.enqueueOutbox(record)
  }

  /**
   * 扫一遍到期的通知并尝试投递。
   *
   * 单次最多处理 `limit` 条；任何一条失败都会**继续处理下一条**（一条通知投不出去
   * 不该阻塞别的通知）。返回值只用于日志与测试。
   *
   * @param limit - 本次最多处理几条。
   * @returns `{ sent, retried, dead }`。
   */
  async function pumpOnce(limit = 20) {
    const stats = { sent: 0, retried: 0, dead: 0 }
    if (closed) return stats

    const due = store.dueOutbox(now(), limit)
    for (const row of due) {
      if (closed) break
      try {
        await deliver(row)
        store.markOutboxSent(row.id)
        stats.sent += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const attempts = Number(row.attempts ?? 0) + 1
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          store.markOutboxDead(row.id, message)
          stats.dead += 1
          // 一条通知彻底送不出去是**用户可见的损失**（他永远不知道那张工单结果），
          // 所以这条必须打出来，不能只留在表里。
          warn(
            `result delivery for ticket ${row.ticket_id} gave up after ${attempts} attempts: ${message}`,
          )
        } else {
          const nextAt = now() + backoffFor(attempts)
          store.markOutboxRetry(row.id, nextAt, message)
          stats.retried += 1
        }
      }
    }
    return stats
  }

  /**
   * 带防重入的泵。重复调用会**共享**同一个进行中的 promise。
   *
   * @param limit - 本次最多处理几条。
   * @returns 本次（或进行中那次）的统计。
   */
  function pump(limit = 20) {
    if (closed) return Promise.resolve({ sent: 0, retried: 0, dead: 0 })
    if (pumping !== null) return pumping
    pumping = pumpOnce(limit).finally(() => {
      pumping = null
    })
    return pumping
  }

  /**
   * 连抽到没有到期行为止（启动恢复用）。
   *
   * 上限 `rounds` 防止某条通知的 `deliver` 每次都「成功但立刻又入队」时死循环 ——
   * 当前实现不会那样，但稳态代码不该依赖这个假设。
   *
   * @param rounds - 最多抽几轮。
   * @returns 累计统计。
   */
  async function drain(rounds = 5) {
    const total = { sent: 0, retried: 0, dead: 0 }
    for (let index = 0; index < rounds; index += 1) {
      if (closed) break
      const stats = await pump()
      total.sent += stats.sent
      total.retried += stats.retried
      total.dead += stats.dead
      // 一条都没动说明队列已经空了（或全都在退避中），再抽也是空转。
      if (stats.sent === 0 && stats.retried === 0 && stats.dead === 0) break
      if (stats.retried > 0) break
    }
    return total
  }

  /** 卸载：让进行中的泵放手，之后不再碰 store。 */
  function dispose() {
    closed = true
  }

  return { enqueue, pump, drain, dispose }
}
