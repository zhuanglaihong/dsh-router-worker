/**
 * Watchdog 纯逻辑单测 —— 零依赖，只用 node:test / node:assert / 可注入假时钟。
 *
 * 这台机器只有 macOS，但本文件不碰 Electron、不碰 DOM、不碰 cordis，
 * 因此可以在 Windows / Linux / macOS 的 CI 上等价运行（Phase 5 矩阵）。
 *
 * 运行： node --test test/watchdog.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createWatchdog,
  WATCHDOG_STUCK_MS,
  WATCHDOG_QUEUED_WARN_MS,
  STUCK_REASON,
  LOST_REASON,
} from '../lib/watchdog.js'

/**
 * 一个够用的假 store：只有 Watchdog 会用到的方法。
 * tickets 是普通对象数组，status 用 markFailed / setStatus 直接改。
 */
function fakeStore(initial = []) {
  const rows = initial.map((r) => ({ ...r }))
  return {
    rows,
    listByStatus(status) {
      return rows.filter((r) => r.status === status).map((r) => ({ ...r }))
    },
    getTicket(id) {
      const r = rows.find((x) => x.id === id)
      return r === undefined ? undefined : { ...r }
    },
    markFailed(id, error) {
      const r = rows.find((x) => x.id === id)
      if (r !== undefined) {
        r.status = 'failed'
        r.error = error
      }
    },
    setStatus(id, status) {
      const r = rows.find((x) => x.id === id)
      if (r !== undefined) r.status = status
    },
  }
}

/** 造一张 running 工单。 */
function running(id, sid, at, extra = {}) {
  return {
    id,
    title: `工单-${id}`,
    parent_session: 'parent-1',
    worker_session: sid,
    status: 'running',
    created_at: at,
    started_at: at,
    updated_at: at,
    ...extra,
  }
}

test('静默满 15 分钟 → 中断 + 标失败 + 通知父会话', async () => {
  let t = 1_000_000
  const store = fakeStore([running('A', 'child-A', t - WATCHDOG_STUCK_MS - 1)])
  const interruptions = []
  const notifications = []
  const logs = []
  const wd = createWatchdog({
    store,
    now: () => t,
    notify: (ticket, body) => notifications.push({ ticket, body }),
    interrupt: async (sid, parent) => interruptions.push({ sid, parent }),
    isAlive: async () => true,
    log: (m) => logs.push(m),
  })

  // 第一次巡检：没有心跳记录 → 只登记、不判（重启 kept 的保护）。
  const first = await wd.sweep()
  assert.equal(first.stuck, 0)
  assert.equal(first.healthy, 1)
  assert.equal(store.getTicket('A').status, 'running')
  assert.equal(interruptions.length, 0)

  // 心跳停在 t，把时钟推到阈值之外。
  wd.touch('child-A') // last = t
  t += WATCHDOG_STUCK_MS + 1
  const second = await wd.sweep()
  assert.equal(second.stuck, 1)
  assert.equal(store.getTicket('A').status, 'failed')
  assert.equal(store.getTicket('A').error, STUCK_REASON)
  assert.equal(interruptions.length, 1)
  assert.deepEqual(interruptions[0], { sid: 'child-A', parent: 'parent-1' })
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].body, /卡住/)
  assert.ok(logs.some((l) => l.includes('[ROUTER-WATCHDOG-FAILED]')))
  wd.dispose()
})

test('持续心跳的 worker 永远不会被判死', async () => {
  let t = 0
  const store = fakeStore([running('A', 'child-A', t)])
  let interrupted = 0
  const wd = createWatchdog({
    store,
    now: () => t,
    notify: () => {},
    interrupt: async () => { interrupted++ },
    isAlive: async () => true,
  })
  // 每次只推进 10 分钟并补一次心跳，跨过多个 15 分钟周期仍应存活。
  for (let i = 0; i < 20; i++) {
    t += 10 * 60_000
    wd.touch('child-A')
    const r = await wd.sweep()
    assert.equal(r.stuck, 0)
  }
  assert.equal(store.getTicket('A').status, 'running')
  assert.equal(interrupted, 0)
  wd.dispose()
})

test('worker_session 为空的 running 行跳过，交给 recoverOnBoot', async () => {
  const store = fakeStore([running('A', '', 0)])
  const wd = createWatchdog({
    store,
    now: () => 0,
    notify: () => {},
    interrupt: async () => { throw new Error('should not be called') },
    isAlive: async () => true,
  })
  const r = await wd.sweep()
  assert.equal(r.skipped, 1)
  assert.equal(r.stuck, 0)
  assert.equal(store.getTicket('A').status, 'running')
  wd.dispose()
})

test('queued 超过 30 分钟只 warn 一次、不改状态', async () => {
  let t = 5_000_000
  const store = fakeStore([
    {
      id: 'Q',
      title: '排队工单',
      parent_session: 'parent-1',
      worker_session: '',
      status: 'queued',
      created_at: t - WATCHDOG_QUEUED_WARN_MS - 1,
    },
  ])
  const warns = []
  const wd = createWatchdog({
    store,
    now: () => t,
    notify: () => {},
    warn: (m) => warns.push(m),
  })
  const r1 = await wd.sweep()
  assert.equal(r1.warned, 1)
  assert.equal(warns.length, 1)
  assert.match(warns[0], /\[ROUTER-WATCHDOG-QUEUED\]/)
  // 再巡检几轮：Set 去重，不能每 60 秒刷同一条；状态永远不动。
  t += 60_000
  const r2 = await wd.sweep()
  assert.equal(r2.warned, 0)
  assert.equal(warns.length, 1)
  assert.equal(store.getTicket('Q').status, 'queued')
  wd.dispose()
})

test('重启后 kept 的工单：脉搏表为空时第一轮不误杀', async () => {
  // started_at 是 40 分钟前，模拟「重启前已经跑了很久、被 recoverOnBoot 判 kept」。
  let t = 10_000_000
  const store = fakeStore([running('A', 'child-A', t - 40 * 60_000)])
  const wd = createWatchdog({
    store,
    now: () => t,
    notify: () => {},
    interrupt: async () => { throw new Error('should not be called') },
    isAlive: async () => true,
  })
  const r = await wd.sweep()
  assert.equal(r.stuck, 0)
  assert.equal(store.getTicket('A').status, 'running')
  // runtime 在恢复完成后会补一次 touch；注册表应当从「现在」起算。
  wd.touch('child-A')
  assert.equal(wd.lastActivityOf('child-A'), t)
  wd.dispose()
})

test('isAlive=false 时省掉 interrupt，用「失联」原因标失败', async () => {
  let t = 0
  const store = fakeStore([running('A', 'child-A', t)])
  let interrupted = 0
  const notifications = []
  const wd = createWatchdog({
    store,
    now: () => t,
    notify: (ticket, body) => notifications.push(body),
    interrupt: async () => { interrupted++ },
    isAlive: async () => false,
  })
  wd.touch('child-A')
  t += WATCHDOG_STUCK_MS + 1
  const r = await wd.sweep()
  assert.equal(r.stuck, 1)
  assert.equal(interrupted, 0, '子会话已经不在了，不该再调 interrupt')
  assert.equal(store.getTicket('A').error, LOST_REASON)
  assert.match(notifications[0], /失联/)
  wd.dispose()
})

test('interrupt 抛错仍然标失败（不把工单永远留在 running）', async () => {
  let t = 0
  const store = fakeStore([running('A', 'child-A', t)])
  const warns = []
  const wd = createWatchdog({
    store,
    now: () => t,
    notify: () => {},
    interrupt: async () => { throw new Error('boom') },
    isAlive: async () => true,
    warn: (m) => warns.push(m),
  })
  wd.touch('child-A')
  t += WATCHDOG_STUCK_MS + 1
  const r = await wd.sweep()
  assert.equal(r.stuck, 1)
  assert.equal(store.getTicket('A').status, 'failed')
  assert.ok(warns.some((m) => m.includes('[ROUTER-WATCHDOG-INTERRUPT-FAILED]')))
  wd.dispose()
})

test('start() 挂定时；dispose() 后不再巡检', async () => {
  let fired = null
  const timer = {
    interval(fn, ms) {
      fired = { fn, ms }
      return () => { fired = null }
    },
  }
  const store = fakeStore([])
  const wd = createWatchdog({ store, timer, now: () => 0, notify: () => {} })
  wd.start()
  assert.equal(fired.ms, 60_000)
  await fired.fn() // 空表，不应抛
  wd.dispose()
  assert.equal(fired, null, 'dispose 必须摘掉定时器')
  const r = await wd.sweep() // closed 后返回全 0
  assert.equal(r.checked, 0)
})

test('sweep 并发重入：共享同一个 promise', async () => {
  const store = fakeStore([running('A', 'child-A', 0)])
  const wd = createWatchdog({
    store,
    now: () => 0,
    notify: () => {},
    isAlive: async () => new Promise((r) => setTimeout(() => r(true), 10)),
  })
  wd.touch('child-A')
  const [a, b] = await Promise.all([wd.sweep(), wd.sweep()])
  // 两处拿到的是同一个结果对象引用（共享 promise），不会各判一次。
  assert.strictEqual(a, b)
  wd.dispose()
})
