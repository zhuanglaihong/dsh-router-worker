/**
 * Provider 契约回归测试 —— 零依赖（node:test / node:assert/strict + 纯 ESM import）。
 *
 * 背景：曾有建议把 `router_worker_ptc` / `router_worker_minimal` 这两个「私有 provider」
 * 收敛成宿主内置的 `spawn`，以减少发布前的特殊处理。核查宿主契约后**决定不做**，
 * 理由与这里的断言一一对应：
 *
 *  1. provider 名原样写进 `subagent/descriptor`（app.asar `manager.startLocal()`：
 *     `snapshotSubagentDescriptor({provider: spec.provider, ...})`），并且是四类 worker
 *     人格与工具面的**唯一路由键**（`worker-persona.mjs` / `subagent-mode.mjs` /
 *     `minimal-guard.mjs` 都按名字分支）。合并成 `spawn` 会让 PTC / minimal 静默退化。
 *  2. 两个 provider 只是给「与上游 in-process spawn 同形」的后端起别名，不是另造执行
 *     引擎；`assertCapabilities()` 要求的能力位必须齐全，否则委派时抛
 *     `UNSUPPORTED_CAPABILITY`。
 *  3. `registerProvider` 对重名硬抛 `DUPLICATE_PROVIDER`，所以绝不能注册 `spawn` /
 *     `fork`（宿主 `dsh-base` 已装好），且注册前必须 `getProvider()` 查重。
 *
 * 这个测试把上述契约钉死：以后有人改名字、改能力位、或试图「收敛」成 spawn，
 * CI 会直接失败，而不是等到真机上四条 worker 里有两条静默不工作。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SUBAGENT_PROVIDER,
  FORK_PROVIDER,
  PTC_PROVIDER,
  MINIMAL_PROVIDER,
  WORKER_PROVIDERS,
  WORKER_MODEL_TYPES,
} from '../presets/router-worker/composition.mjs'
import { WORKER_PROVIDER_NAMES, registerWorkerProviders } from '../lib/worker-providers.js'

// ── 1. 四类 worker 各绑一个独立 provider ───────────────────────────────────
test('四类 worker 的 provider 名互不相同，且 PTC/minimal 不是宿主内置名', () => {
  const names = Object.values(WORKER_PROVIDERS)
  assert.equal(new Set(names).size, 4, '四个 worker 必须各自一个 provider 名')
  assert.equal(SUBAGENT_PROVIDER, 'spawn')
  assert.equal(FORK_PROVIDER, 'fork')
  assert.notEqual(PTC_PROVIDER, SUBAGENT_PROVIDER, 'PTC 不能收敛成 spawn')
  assert.notEqual(MINIMAL_PROVIDER, SUBAGENT_PROVIDER, 'minimal 不能收敛成 spawn')
  assert.ok(/^[a-z_]+$/.test(PTC_PROVIDER), 'provider 名是纯标识符，Windows 上无大小写歧义')
  assert.ok(/^[a-z_]+$/.test(MINIMAL_PROVIDER))
})

test('WORKER_PROVIDER_NAMES 只注册自建的两个，绝不重复注册 spawn/fork', () => {
  assert.deepEqual(WORKER_PROVIDER_NAMES, [PTC_PROVIDER, MINIMAL_PROVIDER])
  assert.ok(!WORKER_PROVIDER_NAMES.includes(SUBAGENT_PROVIDER))
  assert.ok(!WORKER_PROVIDER_NAMES.includes(FORK_PROVIDER))
})

test('WORKER_MODEL_TYPES 与 WORKER_PROVIDERS 的键逐字一致', () => {
  assert.deepEqual([...WORKER_MODEL_TYPES].sort(), Object.keys(WORKER_PROVIDERS).sort())
})

// ── 2. 三类守卫模块里的常量必须与 composition 逐字一致 ─────────────────────
// 它们刻意「复制」常量（不 import composition，避免改一处引发 preset 内循环依赖），
// 所以必须用测试锁住，否则 drift 会静默关闭 minimal 的只读面。
test('守卫模块的 provider 常量与 composition 一致', async () => {
  const fs = await import('node:fs')
  const read = (f) => fs.readFileSync(new URL('../presets/router-worker/' + f, import.meta.url), 'utf8')
  for (const file of ['subagent-mode.mjs', 'minimal-guard.mjs', 'worker-guard.mjs']) {
    const src = read(file)
    assert.ok(src.includes("'" + PTC_PROVIDER + "'") || !src.includes('PTC_PROVIDER'),
      file + ' 的 PTC_PROVIDER 与 composition 不一致')
    assert.ok(src.includes("'" + MINIMAL_PROVIDER + "'") || !src.includes('MINIMAL_PROVIDER'),
      file + ' 的 MINIMAL_PROVIDER 与 composition 不一致')
  }
})

// ── 3. 后端能力与宿主 assertCapabilities 契约一致 ─────────────────────────
test('注册出的 provider 具备全部必需能力位，且支持续接', () => {
  const registered = new Map()
  const subagents = {
    getProvider: (n) => registered.get(n),
    registerProvider: (p) => {
      assert.equal(typeof p.name, 'string')
      assert.equal(p.inheritsParentContext, false, 'spawn 是全新上下文，不能继承父历史')
      for (const cap of ['agentOptions', 'agentPreset', 'outputSchema', 'depthLimit']) {
        assert.equal(p.capabilities[cap], true, '缺少能力位 ' + cap + ' 会让委派失败')
      }
      assert.equal(typeof p.prepareContinuable, 'function', '方法存在本身即「支持续接」')
      assert.ok(p.prepareContinuable() instanceof Promise)
      registered.set(p.name, p)
    },
  }
  const ctx = { get: (n) => (n === 'subagents' ? subagents : undefined), inject: () => ({}) }
  const warnings = []
  registerWorkerProviders(ctx, (msg) => warnings.push(msg))

  assert.deepEqual([...registered.keys()], WORKER_PROVIDER_NAMES)
  assert.deepEqual(warnings, [])
})

test('重复注册同一个名字会被跳过（HMR / 重复插入不会触发 DUPLICATE_PROVIDER）', () => {
  let calls = 0
  const existing = { name: 'already-there' }
  const subagents = {
    getProvider: () => existing,
    registerProvider: () => { calls += 1 },
  }
  const ctx = { get: (n) => (n === 'subagents' ? subagents : undefined), inject: () => ({}) }
  registerWorkerProviders(ctx, () => {})
  assert.equal(calls, 0, '已存在时绝不再注册')
})

test('registerProvider 抛错时只告警，不抛穿宿主启动', () => {
  const subagents = {
    getProvider: () => undefined,
    registerProvider: () => { throw new Error('DUPLICATE_PROVIDER') },
  }
  const ctx = { get: (n) => (n === 'subagents' ? subagents : undefined), inject: () => ({}) }
  const warnings = []
  assert.doesNotThrow(() => registerWorkerProviders(ctx, (msg) => warnings.push(msg)))
  assert.equal(warnings.length, 2)
  assert.ok(warnings.every((w) => w.includes('[ROUTER-PROVIDER-SKIPPED')))
})
