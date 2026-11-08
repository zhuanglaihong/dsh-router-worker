/**
 * lib/platform.js 纯函数单测 —— 零依赖，只用 node:test / node:assert/strict。
 *
 * 核心目的：所有平台判断都通过**显式 platform 参数**注入，因此在这台只有 macOS 的
 * 机器（以及 ubuntu/macos 的 CI runner）上，也能确定性地演练 win32 / darwin / linux
 * 三种平台的分支语义，而不依赖真实操作系统。
 *
 * 运行： node --test test/platform.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isWindows,
  isCaseInsensitive,
  normalizeSlashes,
  isPathWithin,
  tempRoots,
  shellTools,
} from '../lib/platform.js'

const PLATFORMS = ['win32', 'darwin', 'linux']

// ───────────────────────────────────────────────────────────────────────────
// isWindows
// ───────────────────────────────────────────────────────────────────────────
test('isWindows: win32 true；darwin / linux false', () => {
  assert.equal(isWindows('win32'), true)
  assert.equal(isWindows('darwin'), false)
  assert.equal(isWindows('linux'), false)
})

test('isWindows: 未知 / 非法输入一律 false（fail-safe，不抛错）', () => {
  assert.equal(isWindows('WIN32'), false, '大小写必须精确匹配')
  assert.equal(isWindows(''), false)
  assert.equal(isWindows(null), false)
  assert.equal(isWindows(undefined), false)
  assert.equal(isWindows(42), false)
})

// ───────────────────────────────────────────────────────────────────────────
// isCaseInsensitive
// ───────────────────────────────────────────────────────────────────────────
test('isCaseInsensitive: 仅 win32 为 true；darwin / linux false', () => {
  assert.equal(isCaseInsensitive('win32'), true)
  assert.equal(isCaseInsensitive('darwin'), false)
  assert.equal(isCaseInsensitive('linux'), false)
})

test('isCaseInsensitive: 与 isWindows 结果一致（覆盖三平台）', () => {
  for (const p of PLATFORMS) {
    assert.equal(isCaseInsensitive(p), isWindows(p), `平台 ${p} 两者应一致`)
  }
})

// ───────────────────────────────────────────────────────────────────────────
// normalizeSlashes —— 逐字镜像 approval-gate.mjs:507
// ───────────────────────────────────────────────────────────────────────────
test('normalizeSlashes: 反斜杠转正斜杠 + 连续斜杠折叠 + 去首尾空白', () => {
  assert.equal(normalizeSlashes('C:\\Users\\a\\b'), 'C:/Users/a/b')
  assert.equal(normalizeSlashes('  /a///b/  '), '/a/b/')
  assert.equal(normalizeSlashes('a\\\\b'), 'a/b')
  assert.equal(normalizeSlashes('a////\\\\b'), 'a/b')
  assert.equal(normalizeSlashes('plain'), 'plain')
})

test('normalizeSlashes: 非字符串输入不抛错、返回空串', () => {
  assert.equal(normalizeSlashes(null), '')
  assert.equal(normalizeSlashes(undefined), '')
  assert.equal(normalizeSlashes(42), '')
  assert.equal(normalizeSlashes({}), '')
  assert.equal(normalizeSlashes([]), '')
  assert.equal(normalizeSlashes(''), '')
  assert.equal(normalizeSlashes('   '), '')
})

test('normalizeSlashes: 与 upstream approval-gate.mjs:507 表达式逐字等价', () => {
  // 上游 inspectPath() 内的原始表达式，照抄作为 oracle。
  const upstream = (value) => {
    if (typeof value !== 'string' || value.trim() === '') return ''
    return value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  }
  const samples = [
    'C:\\Users\\\\a//b',
    '  /a///b/  ',
    'a\\b',
    '',
    '   ',
    'plain',
    'a////\\\\b',
    'C:/',
    '//server//share',
    123,
    null,
  ]
  for (const s of samples) {
    assert.equal(
      normalizeSlashes(s),
      upstream(s),
      `输入 ${JSON.stringify(s)} 必须与上游一致`,
    )
  }
})

// ───────────────────────────────────────────────────────────────────────────
// isPathWithin —— workspace 前缀比较
// ───────────────────────────────────────────────────────────────────────────
test('isPathWithin: 根本身 / 直接子路径 / 深层子路径都算在内', () => {
  assert.equal(isPathWithin('/work', '/work', 'linux'), true, '根本身')
  assert.equal(isPathWithin('/work/a', '/work', 'linux'), true)
  assert.equal(isPathWithin('/work/a/b/c.txt', '/work', 'linux'), true)
})

test('isPathWithin: 仅有字符串前缀但不构成路径边界时，必须判否（/work vs /workspace）', () => {
  assert.equal(isPathWithin('/workspace/x', '/work', 'linux'), false)
  assert.equal(isPathWithin('/workspace/x', '/work', 'win32'), false)
  assert.equal(isPathWithin('/workbook', '/work', 'linux'), false)
})

test('isPathWithin: 完全不相关的根判否', () => {
  assert.equal(isPathWithin('/etc/passwd', '/work', 'linux'), false)
  assert.equal(isPathWithin('C:\\Windows\\System32', 'D:\\work', 'win32'), false)
})

test('isPathWithin: win32 大小写不敏感（大小写仅差也算在内）', () => {
  assert.equal(isPathWithin('C:\\Work\\File.TXT', 'c:/work', 'win32'), true)
  assert.equal(isPathWithin('c:/WORK', 'C:\\work', 'win32'), true)
})

test('isPathWithin: darwin / linux 大小写敏感（大小写仅差判否）', () => {
  assert.equal(isPathWithin('/Work/x', '/work', 'linux'), false)
  assert.equal(isPathWithin('/Work/x', '/work', 'darwin'), false)
  assert.equal(isPathWithin('/WORK/x', '/work', 'linux'), false)
  // 但大小写完全一致时仍应命中。
  assert.equal(isPathWithin('/Work/x', '/Work', 'linux'), true)
})

test('isPathWithin: 两侧都先规范化反斜杠与重复斜杠', () => {
  // path 用反斜杠、root 用正斜杠，混合写法也应正确比较。
  assert.equal(isPathWithin('C:\\work\\a', 'C:/work/', 'win32'), true)
  assert.equal(isPathWithin('/work//a', '/work///', 'linux'), true)
  assert.equal(isPathWithin('C:\\WORK\\\\a', 'c:\\work', 'win32'), true)
})

test('isPathWithin: root 去尾斜杠，path 尾斜杠不影响', () => {
  assert.equal(isPathWithin('/work/a', '/work/', 'linux'), true)
  assert.equal(isPathWithin('/work/a', '/work///', 'linux'), true)
  assert.equal(isPathWithin('/work', '/work/', 'linux'), true)
})

test('isPathWithin: 坏输入（非字符串 / 空串 / 空 root）返回 false 而非抛错', () => {
  assert.equal(isPathWithin(null, '/work', 'linux'), false)
  assert.equal(isPathWithin(undefined, '/work', 'linux'), false)
  assert.equal(isPathWithin(123, '/work', 'linux'), false)
  assert.equal(isPathWithin('/work/a', null, 'linux'), false)
  assert.equal(isPathWithin('/work/a', 42, 'linux'), false)
  assert.equal(isPathWithin('', '/work', 'linux'), false)
  assert.equal(isPathWithin('/work/a', '', 'linux'), false)
  assert.equal(isPathWithin('   ', '   ', 'linux'), false)
  // 用一个「一切都会抛」的对象当 root，也应被安全挡住。
  assert.equal(isPathWithin('/work/a', {}, 'linux'), false)
})

// ───────────────────────────────────────────────────────────────────────────
// tempRoots
// ───────────────────────────────────────────────────────────────────────────
test('tempRoots: 三平台都返回非空数组（是 hints，非权威值）', () => {
  for (const p of PLATFORMS) {
    const roots = tempRoots(p)
    assert.ok(Array.isArray(roots), `平台 ${p} 应返回数组`)
    assert.ok(roots.length > 0, `平台 ${p} 不应为空`)
    assert.ok(roots.every((r) => typeof r === 'string' && r.length > 0))
  }
})

test('tempRoots: win32 含 %LOCALAPPDATA%\\Temp 风格提示；非 win32 含 /tmp', () => {
  const win = tempRoots('win32')
  assert.ok(
    win.some((r) => r.includes('LOCALAPPDATA') && r.includes('Temp')),
    'win32 必须带 %LOCALAPPDATA%\\Temp 提示',
  )
  for (const p of ['darwin', 'linux']) {
    assert.ok(tempRoots(p).includes('/tmp'), `${p} 应带 /tmp 提示`)
  }
  // 纯函数：不读 process.env，重复调用结果稳定。
  assert.deepEqual(tempRoots('win32'), tempRoots('win32'))
})

// ───────────────────────────────────────────────────────────────────────────
// shellTools —— 逐字镜像 composition.mjs:1119/1124
// ───────────────────────────────────────────────────────────────────────────
test('shellTools: win32 启用 pwsh、禁用 bash；非 win32 反之', () => {
  assert.deepEqual(shellTools('win32'), { pwshDisabled: false, bashDisabled: true })
  assert.deepEqual(shellTools('darwin'), { pwshDisabled: true, bashDisabled: false })
  assert.deepEqual(shellTools('linux'), { pwshDisabled: true, bashDisabled: false })
})

test('shellTools: 三平台上 pwsh / bash 恰好一个启用、一个禁用（互斥）', () => {
  for (const p of PLATFORMS) {
    const { pwshDisabled, bashDisabled } = shellTools(p)
    assert.equal(typeof pwshDisabled, 'boolean')
    assert.equal(typeof bashDisabled, 'boolean')
    assert.equal(pwshDisabled, !bashDisabled, `平台 ${p} 两者必须互斥`)
  }
})

// ───────────────────────────────────────────────────────────────────────────
// 关键命题：Windows 专属逻辑能在「非 Windows 宿主机」上被演练
// ───────────────────────────────────────────────────────────────────────────
test('windows path logic is exercised on a non-windows host（平台可模拟性证明）', () => {
  // 无论真实 process.platform 是什么，只要显式传入 'win32'，就走 Windows 语义。
  // 这正是本轨道的意义：在 macOS / Linux CI runner 上验证 Windows-only 分支。
  assert.equal(isWindows('win32'), true)
  assert.equal(isCaseInsensitive('win32'), true)
  assert.equal(
    isPathWithin('C:\\WORKSPACE\\Sub\\file.txt', 'c:/workspace', 'win32'),
    true,
    '大小写不同仍算在工作区内 —— win32 专属语义在此被演练',
  )
  assert.equal(
    isPathWithin('C:\\WORKSPACE\\Sub\\file.txt', 'c:/workspace', 'linux'),
    false,
    '同一对路径在 linux 语义下判否 —— 证明分支由参数决定、而非宿主机',
  )
  assert.deepEqual(shellTools('win32'), { pwshDisabled: false, bashDisabled: true })
  assert.ok(tempRoots('win32').some((r) => r.includes('LOCALAPPDATA')))

  // 并且：即使本机就是 darwin，也能同时演练另外两个平台。
  assert.equal(isWindows('darwin'), false)
  assert.equal(isWindows('linux'), false)
  assert.deepEqual(shellTools('linux'), { pwshDisabled: true, bashDisabled: false })
})
