/**
 * 平台分支的「可注入、可测试」参考实现 —— 纯 ESM、零依赖、零副作用。
 *
 * 本文件刻意与 presets/router-worker/ 下的三个文件分开：
 *   - presets/router-worker/workspace-acl.mjs
 *   - presets/router-worker/approval-gate.mjs
 *   - presets/router-worker/composition.mjs
 * 这三份是从 upstream MIT 项目**逐字复制**过来的，保持原样是为了让 upstream diff
 * 干净，因此这里不改动它们、也不 import 它们。本模块只把它们内部的内联平台判断
 * （process.platform === 'win32'、路径规范化表达式、大小写敏感标志、pwsh/bash 开关、
 * %LOCALAPPDATA%\Temp 临时根提示）**镜像成纯函数**。
 *
 * 关键设计：所有依赖平台的导出函数都把 OS 当作**显式字符串参数**传入
 * （'win32' | 'darwin' | 'linux'），模块内部完全不读 process.platform。
 * 于是在只有 macOS 的开发机、以及 ubuntu/macos 的 CI runner 上，也能确定性地
 * 演练 Windows 专属逻辑（路径大小写比较、pwsh/bash 工具开关等），而不必真的有
 * 一台 Windows 机器。process.platform 若要用，只应出现在最外层调用点。
 *
 * 这些是「参考实现」而非运行时代码：三个预设文件仍各自保留原样判断。本模块用于
 * 单测与文档，帮助三平台验证轨道证明「分支语义」正确；真机 ACL 与 Electron GUI
 * 冒烟仍然不可替代（见 docs/PLATFORM.md）。
 */

/**
 * 是否为 Windows。镜像 workspace-acl.mjs:185 的
 * `const IS_WINDOWS = process.platform === 'win32'` 以及 approval-gate.mjs:1020 /
 * composition.mjs:1119/1124 的同类判断。
 *
 * @param {'win32'|'darwin'|'linux'} platform 显式注入的平台字符串。
 * @returns {boolean} 仅当 platform === 'win32' 时为 true。
 */
export function isWindows(platform) {
  return platform === 'win32'
}

/**
 * 路径比较是否大小写不敏感。镜像 approval-gate.mjs:1020 的
 * `const caseInsensitive = process.platform === 'win32'`（win32 路径大小写不敏感）。
 *
 * @param {'win32'|'darwin'|'linux'} platform 显式注入的平台字符串。
 * @returns {boolean} win32 → true；darwin / linux → false。
 */
export function isCaseInsensitive(platform) {
  return isWindows(platform)
}

/**
 * 把路径规范化成可比较形式：**逐字镜像** approval-gate.mjs:507 的表达式
 * `value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')`。
 *
 * 反斜杠 → 正斜杠，连续正斜杠折叠为一，首尾空白去掉。与上游 inspectPath() 一样，
 * 非字符串（含 null / undefined / 数字 / 对象）不抛错，返回空串 ''。
 * 此函数与平台无关，故按签名只接收 value，不接收 platform。
 *
 * @param {unknown} value 原始路径。
 * @returns {string} 规范化后的路径；非字符串返回 ''。
 */
export function normalizeSlashes(value) {
  if (typeof value !== 'string') return ''
  return value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
}

/**
 * 词法前缀判断：path 是否落在 root 之内（含 root 本身）。
 * 镜像 approval-gate.mjs 的 workspace-prefix 比较（isUnderRoots:760-767 /
 * escapesWorkspace:539-545）：`a === b || a.startsWith(b + '/')`，且 root 去尾斜杠。
 *
 * - 两侧输入都先经 normalizeSlashes() 规范化；
 * - win32 走大小写不敏感比较（toLowerCase），darwin / linux 大小写敏感；
 * - 坏输入（非字符串、空串、空 root）一律返回 false，绝不抛错；
 * - 只做纯词法比较，不解析文件系统、不处理 `..` 上溯（上游在 isUnderRoots 里另加
 *   fail-closed 的遍历段拒绝，那是策略层，不属于这里镜像的「前缀比较」本身）。
 *
 * @param {unknown} path 待判定的路径。
 * @param {unknown} root 允许根（工作区前缀）。
 * @param {'win32'|'darwin'|'linux'} platform 显式注入的平台字符串。
 * @returns {boolean} 落在 root 内为 true，否则 false。
 */
export function isPathWithin(path, root, platform) {
  const a = normalizeSlashes(path)
  const b = normalizeSlashes(root).replace(/\/+$/, '')
  if (a === '' || b === '') return false
  const fold = isCaseInsensitive(platform)
    ? (text) => text.toLowerCase()
    : (text) => text
  const fa = fold(a)
  const fb = fold(b)
  return fa === fb || fa.startsWith(`${fb}/`)
}

/**
 * 临时根目录**提示**（hints，非权威值）。镜像 approval-gate.mjs:576-590 的
 * `defaultTempRoots()`：win32 上补一条 `%LOCALAPPDATA%\Temp`，其余平台用标准
 * `/tmp` 家族。上游会读 process.env.TEMP/TMP/TMPDIR/LOCALAPPDATA 并去重；这里刻意
 * 不读环境变量以保持纯函数、结果可预测，只给出用于单测与文档的静态提示。
 *
 * @param {'win32'|'darwin'|'linux'} platform 显式注入的平台字符串。
 * @returns {string[]} 临时根提示数组（win32 含 %LOCALAPPDATA%\Temp 风格项）。
 */
export function tempRoots(platform) {
  if (isWindows(platform)) {
    return ['%LOCALAPPDATA%\\Temp', 'C:\\Windows\\Temp', '/tmp']
  }
  return ['/tmp', '/var/tmp']
}

/**
 * shell 工具开关。逐字镜像 composition.mjs:1119/1124：
 *   - tool-bash: `disabled: process.platform === 'win32'`
 *   - tool-pwsh: `disabled: process.platform !== 'win32'`
 * 即 win32 上启用 pwsh、禁用 bash；非 win32 上启用 bash、禁用 pwsh。
 *
 * @param {'win32'|'darwin'|'linux'} platform 显式注入的平台字符串。
 * @returns {{ pwshDisabled: boolean, bashDisabled: boolean }}
 */
export function shellTools(platform) {
  const win = isWindows(platform)
  return {
    pwshDisabled: !win, // composition.mjs:1124 → disabled: process.platform !== 'win32'
    bashDisabled: win,  // composition.mjs:1119 → disabled: process.platform === 'win32'
  }
}
