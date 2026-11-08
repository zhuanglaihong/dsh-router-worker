/**
 * 侧栏树「结构无关」回归测试 —— 零依赖（node:test / node:assert/strict / node:vm）。
 *
 * 为什么需要它：2026-11-08 用户启用 `dsh-claude-style` 后，侧栏树整块错位
 * （主行变成空灰条、子行与引导线断成两截）。根因不是主题颜色，而是**DOM 结构**：
 * claude-style 的 dateGroups 把每个会话行包进一层 box（`box = row.parentElement`），
 * 用 `appendChild(box)` 按日期整体搬动、用 `box.style.display="none"` 整体隐藏、往
 * row 里插 date-chip。旧实现有三处假设在这套结构下全崩：
 *
 *   ① `row.insertAdjacentElement("afterend", holder)` 把子树塞进 box 内部，被重排
 *      逻辑当成杂项；② 往宿主行里塞绝对定位箭头、改 padding / 标题 margin，皮肤
 *      插 chip 后标题被推没；③ CSS 写死 48/64px，换皮肤/密度不再对齐。
 *
 * 现在的规则只有一条：**宿主行一个字节都不动**。子树作为该行的兄弟插在它自己的
 * 容器里，箭头/状态条/子行全部画在自己的块里，缩进按主题字号（em）算。
 *
 * 本测试用 vm 驱动**真实 `lib/client.js`**，同时模拟两种 DOM：
 *   A. 原生 DSH：`list > row`
 *   B. claude-style：`list > box > row`，并复现 `E()` 的 `appendChild(box)` 搬动
 * 断言：宿主行始终干净、holder 始终与父行同容器、重排后仍连着文档。
 *
 * 它跑在纯 Node 里（不需要 Electron / jsdom / 浏览器），所以三平台 CI 都会执行。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const CLIENT_URL = new URL('../lib/client.js', import.meta.url)
const src = fs.readFileSync(CLIENT_URL, 'utf8')

/* ── 极简 DOM stub（只实现 client.js 真正用到的那部分）────────────────── */
class El {
  constructor(tag) {
    this.tag = tag; this.children = []; this.attrs = {}; this.dataset = {};
    this.style = {}; this.textContent = ''; this._listeners = {};
    this.parentNode = null; this.isConnected = true;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  hasAttribute(k) { return this.attrs[k] != null; }
  removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) {
    if (c.parentNode) c.parentNode.children = c.parentNode.children.filter(x => x !== c);
    c.parentNode = this; this.children.push(c); return c;
  }
  insertBefore(c, ref) {
    if (c.parentNode) c.parentNode.children = c.parentNode.children.filter(x => x !== c);
    c.parentNode = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  insertAdjacentElement(_pos, c) {
    const p = this.parentNode;
    if (p) {
      if (c.parentNode) c.parentNode.children = c.parentNode.children.filter(x => x !== c);
      const i = p.children.indexOf(this);
      c.parentNode = p; p.children.splice(i + 1, 0, c);
    }
    return c;
  }
  addEventListener(t, fn) { (this._listeners[t] ||= []).push(fn); }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this);
      if (i >= 0) this.parentNode.children.splice(i, 1);
    }
    this.parentNode = null; this.isConnected = false;
    for (const c of this.children) c.isConnected = false;
  }
  querySelector(sel) { return qsa(sel, this).filter(n => n !== this)[0] ?? null; }
  querySelectorAll(sel) { return qsa(sel, this).filter(n => n !== this); }
  get firstChild() { return this.children[0] ?? null; }
  get parentElement() { return this.parentNode; }
  get offsetLeft() { return 30; }
  get offsetWidth() { return 16; }
}
function walk(node, out = []) { out.push(node); for (const c of node.children) walk(c, out); return out; }
function qsa(sel, root) {
  const all = walk(root);
  if (sel.startsWith('[data-row-key^="session:"]'))
    return all.filter(n => (n.getAttribute('data-row-key') || '').startsWith('session:'));
  const m = sel.match(/^\[([^\]=]+)\]$/);
  if (m) return all.filter(n => n.getAttribute(m[1]) != null);
  return [];
}

const byId = {
  c1: { id: 'c1', origin: 'subagent', parentId: 'p1', displayTitle: 'worker one', running: true, createdAt: 1 },
  c2: { id: 'c2', origin: 'subagent', parentId: 'p1', displayTitle: 'worker two', running: false, createdAt: 2 },
};
const snapshot = {
  byId,
  projectionsBySession: {
    p1: { values: { subagentCatalog: [
      { id: 'c1', label: '核对版本号' }, { id: 'c2', label: '统计行数' },
    ] } },
  },
};
const sessions = { list: { getSnapshot: () => snapshot, subscribe: () => () => {} }, open: () => {} };

function mkEnv({ boxed }) {
  const body = new El('body'), head = new El('head'), listRoot = new El('div');
  body.appendChild(listRoot);
  const rows = {};
  for (const id of ['p1', 'p2', 'p3']) {
    const r = new El('div'); r.setAttribute('data-row-key', 'session:' + id);
    const title = new El('span'); title.textContent = '会话 ' + id; r.appendChild(title);
    if (boxed) {
      const box = new El('div'); box.setAttribute('data-claude-box', id);
      box.appendChild(r); listRoot.appendChild(box);
    } else {
      listRoot.appendChild(r);
    }
    rows[id] = r;
  }
  const documentStub = {
    baseURI: 'dsh-app://app/', head, body, documentElement: body,
    getElementById: (id) => walk(body).find(n => n.attrs.id === id) ?? null,
    createElement: (t) => new El(t),
    createElementNS: () => new El('svg'),
    querySelectorAll: (sel) => qsa(sel, body),
    querySelector: (sel) => qsa(sel, body)[0] ?? null,
  };
  let registration = null;
  const window = { __ModuleLoader__: { load: (r) => { registration = r; } } };
  const reactStub = { createElement: () => ({}), useSyncExternalStore: (_s, g) => g(), useState: (i) => [i, () => {}], useEffect: () => {} };
  const requireStub = (n) => n === 'react' ? reactStub : (() => { throw new Error('unexpected require ' + n); })();
  const fetchStub = async () => ({ json: async () => ({ ok: true, value: [
    { id: 't1', parent: 'p2', title: '打包清单', status: 'queued' },
  ] }) });
  const store = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const sandbox = {
    window, require: requireStub, document: documentStub, console,
    localStorage: store, fetch: fetchStub,
    AbortController: class { constructor() { this.signal = {}; } abort() {} },
    setTimeout: () => 0, clearTimeout: () => {},
    requestAnimationFrame: (fn) => fn(),
    MutationObserver: class { observe() {} disconnect() {} },
    URL, Symbol, Object, Array, Map, Set, Number, String, JSON, Date, Math, parseInt, Boolean, RegExp, Error, TypeError,
    HTMLElement: El,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const module = registration.factory(requireStub);
  const ctx = {
    effect: (fn) => fn(),
    locale: { register: () => {}, bind: () => (k) => k },
    slots: { inject: () => () => {}, register: () => () => {} },
    get: (n) => n === 'sessions' ? sessions : undefined,
    inject: () => ({}),
    sessions,
  };
  let applyErr = null;
  try { module.apply(ctx); } catch (e) { applyErr = e; }
  return { body, listRoot, rows, applyErr, settle: () => new Promise(r => setTimeout(r, 60)) };
}

function inspect(env) {
  const all = walk(env.body);
  const holders = all.filter(n => n.hasAttribute('data-dsh-subagent-tree-of'));
  const ctrls = all.filter(n => n.hasAttribute('data-dsh-subagent-tree-ctrl'));
  const toggles = all.filter(n => n.hasAttribute('data-dsh-subagent-tree-toggle'));
  const childRows = all.filter(n => n.hasAttribute('data-dsh-subagent-tree-row'));
  const hostClean = Object.values(env.rows).every(r =>
    !r.hasAttribute('data-dsh-subagent-tree-host') &&
    !r.hasAttribute('data-dsh-subagent-tree-pad') &&
    !r.hasAttribute('data-dsh-subagent-tree-push') &&
    r.children.length === 1 && r.children[0].textContent.startsWith('会话 '));
  const sameParent = holders.every(h => {
    const row = env.rows[h.getAttribute('data-dsh-subagent-tree-of')];
    return row && h.parentElement === row.parentElement;
  });
  const connected = holders.every(h => h.isConnected && walk(env.body).includes(h));
  return { holders, ctrls, toggles, childRows, hostClean, sameParent, connected, applyErr: env.applyErr };
}

test('原生 DSH（list > row）：子树紧跟父行、宿主行不被改动', async () => {
  const env = mkEnv({ boxed: false });
  await env.settle();
  const r = inspect(env);
  assert.equal(r.applyErr, null)
  assert.equal(r.holders.length, 2, 'p1 有子对话、p2 有排队工单 → 两个 holder')
  assert.equal(r.ctrls.length, 1)
  assert.equal(r.toggles.length, 1, '箭头画在自己的块里，不塞进宿主行')
  assert.equal(r.childRows.length, 2)
  assert.ok(r.hostClean, '宿主行必须一个字节都不动')
  assert.ok(r.sameParent)
  assert.ok(r.connected)
})

test('claude-style（list > box > row）：重排 box 后子树仍与父行同容器', async () => {
  const env = mkEnv({ boxed: true });
  await env.settle();
  const before = inspect(env);
  assert.equal(before.applyErr, null)
  assert.ok(before.hostClean)
  assert.ok(before.sameParent, 'holder 必须是 box 的子节点，不能跑到 box 外面')
  assert.ok(before.connected)
  assert.equal(before.holders.length, 2)

  // 复现 dateGroups 的 E()：for (U of P) v.appendChild(U.box)
  const boxes = env.listRoot.children.filter(c => c.hasAttribute('data-claude-box'));
  for (const b of boxes) env.listRoot.appendChild(b);

  const after = inspect(env);
  assert.equal(after.holders.length, 2, '重排后子树不能丢')
  assert.equal(after.ctrls.length, 1)
  assert.equal(after.childRows.length, 2)
  assert.ok(after.hostClean)
  assert.ok(after.sameParent, '重排后 holder 仍与父行在同一个 box 里')
  assert.ok(after.connected)
  const parents = after.holders.map(h => h.parentElement?.getAttribute('data-claude-box') ?? 'list');
  assert.deepEqual(parents, ['p1', 'p2'])
})

test('CSS 不再写死像素，缩进按主题字号计算', () => {
  assert.ok(src.includes('--sat-line'), '引导线位置必须是变量')
  assert.ok(src.includes('--sat-indent'), '文字缩进必须是变量')
  assert.ok(src.includes('var(--dsw-font-size-sm'), '缩进按主题字号缩放')
  assert.ok(!/left:\s*48px/.test(src), '不再写死 48px')
  assert.ok(!/padding:\s*3px 8px 3px 64px/.test(src), '不再写死 64px')
  assert.ok(!src.includes('paddingInlineStart'), '不再改宿主行 padding')
  assert.ok(!src.includes('marginInlineStart'), '不再改宿主标题 margin')
  assert.ok(!src.includes('placeToggle'), '旧的「往宿主行塞绝对定位箭头」已删除')
  assert.ok(src.includes('function attachHolder'), '改由 attachHolder 结构无关地挂靠')
  assert.ok(src.includes('function holdersAligned'), '皮肤重建 DOM 时能强制重挂')
})
