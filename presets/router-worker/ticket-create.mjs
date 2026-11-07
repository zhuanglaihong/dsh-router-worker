/**
 * router-worker-ticket-create — 把「派活」升格为「开一张工单」。
 *
 * ── 它解决什么问题 ────────────────────────────────────────────────────────────
 *
 * 上游的四个委派工具（`subagent` / `subagent_fork` / `subagent_ptc` /
 * `subagent_minimal`）都接受一个 `description`，而那个字段会进宿主记录的
 * `subagentCatalog.label` —— `dsh-subagent-tree` 的侧栏子对话树显示的就是它。
 *
 * 问题是 `description` 在那些工具的 schema 里是**可选**的，且描述只有一句
 * “A short (3-5 word) label for display”。实测里协调者十次有九次不传，于是侧栏
 * 显示的是提示词正文的第一行（`You are a worker executing…`），用户完全看不出
 * 每个子对话在干什么。
 *
 * 本模块把「起名」从**可选参数**变成**工单的第一等字段**：
 *
 *     ticket_create({ title: '核对版本号', brief: '……' })
 *
 * `title` 必填、有字符数上限、直接作为 `label` 传给 `startActivation`。这样侧栏
 * 天然是短语，而不是靠提示词里写「记得传 description」这种容易漂移的软约束。
 *
 * ── 为什么是「工单」而不是又一个委派工具 ──────────────────────────────────────
 *
 * Phase 1 只做「起名 + 委派」，工单记录暂时留在内存里（`ticketId` 已经是稳定的
 * UUID 形状，便于日志对照）。Phase 2 会把同一张表落到 `node:sqlite`
 * （`$DSH_HOME/state/router-worker/tickets.db`），届时本模块的 `execute` 换成
 * 「先写库、再入队」，对模型**完全透明** —— 工具名、参数、返回形状都不变。
 *
 * 所以这里刻意**不**把 state 做成配置项，也**不**导出内部 Map：工单的持久化是
 * Phase 2 的实现细节，提前暴露只会让模型学会依赖一个会变的东西。
 *
 * ── 为什么 `title` 的限制是 2–40 字 ──────────────────────────────────────────
 *
 * 下限 2：一个字的名字（「查」「改」）不携带任何信息，等于没起名。
 * 上限 40：侧栏一行大约能放下 20 个汉字（再长就省略号），40 是「略超但要能完整
 * 显示在悬浮提示里」的长度；再长就说明协调者在写任务书标题而不是短名。
 * 这两个数**只在这里校验**，不写进 schema 的 `maxLength` —— JSON Schema 的
 * 字符计数按 code point 算，与用户看到的「字」在 emoji / 组合字上不一致，容易
 * 把一条合法短名拒掉。校验放在 `execute` 里才能给出**可读的中文拒绝**。
 *
 * ── 失败取向 ─────────────────────────────────────────────────────────────────
 *
 * 与 `preset-dispatch.mjs` 同向：**绝不吞错**。派不出去时把原因原样带回去，让
 * 协调者能改派（换 worker 类型 / 缩并发 / 修目录），而不是对着一个空 id 发呆。
 *
 * @module dsh-subagent-tree/presets/router-worker/ticket-create
 */

import { randomUUID } from 'node:crypto'

/** Cordis 插件名，用于 loader 诊断。 */
export const name = 'router-worker-ticket-create'

/**
 * 注册 `ticket_create` 需要工具注册表与子代理服务。
 *
 * 用 `inject` 而不是「apply 里探测」：本模块的全部价值就是这条委派路径，服务不在时
 * 注册一个必然失败的工具只会让协调者白烧一轮。让 loader 把它显示为
 * “waiting for subagents” 比塞一个坏工具诚实。
 */
export const inject = ['tools', 'subagents']

/** 工具名 —— 与协调者保留集里的那一项必须逐字一致。 */
export const TOOL_NAME = 'ticket_create'

/**
 * 四类 worker 的「类型键 → provider 名」映射。
 *
 * ⚠️ 必须与 `composition.mjs` 的 `WORKER_PROVIDERS` **逐字一致**。
 * 两个文件各自留一份而不是互相 import，是为了守住本目录「子模块零相对 import」的
 * 约定（相对 import 不继承入口的 `?v=N` query，改文本后会取回旧模块且不报错）。
 * 代价是改一处必须改两处。
 */
const WORKER_PROVIDERS = {
  subagent: 'spawn',
  subagent_fork: 'fork',
  subagent_ptc: 'router_worker_ptc',
  subagent_minimal: 'router_worker_minimal',
}

/** 允许的 worker 类型（顺序即 schema 里的枚举顺序，从最常用到最窄）。 */
const WORKER_TYPES = ['subagent', 'subagent_minimal', 'subagent_ptc', 'subagent_fork']

/** 短名的长度区间（按字符长度计，见文件头注释）。 */
const TITLE_MIN = 2
const TITLE_MAX = 40

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: {
      type: 'string',
      description:
        'The ticket title: a short (2-40 characters, ideally 3-5 words) name for this piece of work, in the user\u2019s language. ' +
        'It is what the user sees in the sidebar for this child conversation, so name the deliverable, not the method: ' +
        '「核对版本号」「修 0.2.0 打包清单」 rather than 「assistant」「task」 or the first line of the brief.',
    },
    brief: {
      type: 'string',
      description:
        'The complete, self-contained task brief. The worker does not see this conversation, so everything it needs must be here: ' +
        'goal, verified current state, project conventions, safety rails, write scope, numbered steps, conditional branches, ' +
        'stop conditions, and the report format.',
    },
    worker: {
      type: 'string',
      enum: WORKER_TYPES,
      description:
        'Which kind of worker runs this ticket. Defaults to `subagent` (full tool surface). ' +
        '`subagent_minimal` is read-only (investigate and report); `subagent_ptc` writes programs instead of calling tools one by one ' +
        '(best for filtering/aggregating large amounts of data); `subagent_fork` continues from this conversation\u2019s completed turns.',
    },
  },
  required: ['title', 'brief'],
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', description: 'False when the ticket was refused; the message says why.' },
    ticketId: { type: 'string', description: 'Stable ticket id, present only when ok.' },
    subagentId: { type: 'string', description: 'Durable child session id, present only when ok.' },
    message: { type: 'string', description: 'Human-readable result, or the exact refusal.' },
  },
  required: ['ok', 'message'],
}

/**
 * 每次进程只警告一次的记录器（与本目录其余模块同款）。
 *
 * @param ctx - 插件上下文。
 * @returns 记录函数。
 */
function warnOnceFactory(ctx) {
  const seen = new Set()
  return (message) => {
    if (seen.has(message)) return
    seen.add(message)
    try {
      ctx.logger?.warn?.(`dsh-subagent-tree/ticket-create: ${message}`)
    } catch {
      // 日志通道不可用不能反过来炸掉会话。
    }
  }
}

/**
 * 判断一个 agent 是不是被委派出来的子代理。
 *
 * 三个信号任一成立即视为子代理 —— 与 `coordinator-guard.mjs` / `minimal-guard.mjs` /
 * `subagent-mode.mjs` / `approval-gate.mjs` / `preset-dispatch.mjs` 保持**同一条判据**。
 *
 * 这里必须挡住的原因很机械：委派深度固定为 1，worker 再开票只会在 `startActivation`
 * 里撞 `subagent depth 2 exceeds maxDepth 1`。那次失败白烧一轮，而报错指向深度限制、
 * 与本模块毫无关系，很容易被误读成「工单功能坏了」。
 *
 * @param agent - 待判定的 agent。
 * @returns 是否为被委派的子代理。
 */
function isDelegatedChild(agent) {
  const header = agent?.session?.header
  if (header === undefined || header === null || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  if (typeof header.parentSession === 'string' && header.parentSession !== '') return true
  if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  return false
}

/**
 * 规范化并校验短名。
 *
 * 只做两件保守的事：去掉首尾空白、把内部连续空白折成一个空格。**不做**大小写或标点
 * 改写 —— 中文短名不需要，而擅自改写用户语言里的名字比原样保留更糟。
 *
 * @param raw - 模型传进来的 `title`。
 * @returns `{ ok: true, title }` 或 `{ ok: false, message }`。
 */
function normalizeTitle(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, message: 'A `title` is required: a short (2-40 character) name for this ticket.' }
  }
  const title = raw.trim().replace(/\s+/g, ' ')
  if (title === '') {
    return { ok: false, message: 'A `title` is required: a short (2-40 character) name for this ticket.' }
  }
  const length = [...title].length
  if (length < TITLE_MIN) {
    return {
      ok: false,
      message: `The ticket title "${title}" is too short (${length} character). Name what this ticket produces, in 3-5 words.`,
    }
  }
  if (length > TITLE_MAX) {
    return {
      ok: false,
      message:
        `The ticket title is ${length} characters, over the ${TITLE_MAX} limit. That usually means the brief was pasted into the title: ` +
        'put the task in `brief` and give the ticket a 3-5 word name.',
    }
  }
  return { ok: true, title }
}

/**
 * 装载本模块：注册 `ticket_create`。
 *
 * @param ctx - preset scope 的插件上下文。
 * @param config - `{ enabled }`（见 `composition.mjs` 那一行）。
 */
export function apply(ctx, config) {
  if (config?.enabled === false) return

  const warn = warnOnceFactory(ctx)

  /**
   * Phase 1 的工单表：进程内、只增不减。
   *
   * Phase 2 换成 `node:sqlite` 之后这张 Map 会被删掉，所以现在**不导出**它，
   * 也不给任何读取路径 —— 否则模型会开始依赖一个必然消失的东西。
   */
  const tickets = new Map()

  /**
   * 取子代理服务。
   *
   * @returns 子代理服务，或 undefined。
   */
  const subagentsOf = () => {
    try {
      const service = ctx.get?.('subagents')
      if (service !== undefined && service !== null) return service
    } catch {
      // 服务不可用不是致命错误：调用方会给出可读的拒绝。
    }
    return undefined
  }

  /**
   * 开一张工单并把它派出去。
   *
   * @param args - 工具参数。
   * @param exec - 工具执行输入（含 `agent` / `signal`）。
   * @returns 输出对象。
   */
  const createTicket = async (args, exec) => {
    const titleResult = normalizeTitle(args?.title)
    if (titleResult.ok !== true) return { ok: false, message: titleResult.message }
    const title = titleResult.title

    const brief = typeof args?.brief === 'string' ? args.brief : ''
    if (brief.trim() === '') {
      return {
        ok: false,
        message: 'A non-empty `brief` is required: the worker does not see this conversation, so the brief must be self-contained.',
      }
    }

    const workerType = typeof args?.worker === 'string' && WORKER_TYPES.includes(args.worker) ? args.worker : 'subagent'
    const providerName = WORKER_PROVIDERS[workerType]

    const parent = exec?.agent
    if (parent === undefined || parent === null) {
      return { ok: false, message: 'This tool requires a calling Agent (exec.agent was undefined).' }
    }

    if (isDelegatedChild(parent)) {
      return {
        ok: false,
        message:
          'A delegated worker cannot open further tickets (delegation depth is fixed at 1). ' +
          'Do the work yourself, or report back so the coordinator can open the ticket.',
      }
    }

    const subagents = subagentsOf()
    if (subagents === undefined || typeof subagents.startActivation !== 'function') {
      return { ok: false, message: 'The subagent service is unavailable, so the ticket cannot be dispatched.' }
    }

    // provider 没装上（`DSH_ROUTER_WORKER_MULTI_MODE=0`，或那两行 spawn 副本没启用）时，
    // 这里给出**可改派**的拒绝，而不是让 startActivation 抛一条 provider 不存在的错。
    try {
      const known = subagents.getProvider?.(providerName)
      if (known === undefined || known === null) {
        return {
          ok: false,
          message:
            `The "${workerType}" worker is not available in this deployment (provider "${providerName}" is not registered). ` +
            'Open this ticket with `worker: "subagent"` instead.',
        }
      }
    } catch {
      // 读不到 name 表就交给 startActivation 去判：它会给出真实的失败原因。
    }

    // 与上游 `tool-subagent` 同形：可选字段只在有值时才写进去，避免用显式的 undefined
    // 顶掉后端默认值。
    const request = {
      prompt: [{ type: 'text', text: brief }],
      parent,
    }
    try {
      const maxDepth = subagents.resolveMaxDepth?.(1)
      if (maxDepth !== undefined) request.maxDepth = maxDepth
    } catch {
      // 解析不了就不带：让服务用它自己的默认值。
    }

    const ticketId = randomUUID()

    try {
      const activation = await subagents.startActivation({
        provider: providerName,
        // ★ 本模块存在的全部理由：短名直接当 label，进 `subagentCatalog.label`。
        label: title,
        request,
        signal: exec?.signal,
        delivery: 'parent',
      })
      const subagentId = typeof activation?.childId === 'string' ? activation.childId : undefined
      if (subagentId === undefined) {
        return { ok: false, message: `Dispatching ticket "${title}" returned no subagent id.` }
      }
      tickets.set(ticketId, {
        id: ticketId,
        title,
        worker: workerType,
        subagentId,
        createdAt: Date.now(),
      })
      ctx.logger?.info?.(
        `dsh-subagent-tree: ticket "${title}" (${workerType}) dispatched as subagent ${subagentId} [TICKET-CREATE-STARTED]`,
      )
      return { ok: true, ticketId, subagentId, message: `Opened ticket "${title}" (${workerType}): ${subagentId}` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`opening ticket "${title}" failed: ${message} [TICKET-CREATE-SKIPPED reason=start-threw]`)
      return { ok: false, message: `Opening ticket "${title}" failed: ${message}` }
    }
  }

  try {
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        'Open a work ticket and dispatch it to a worker. This is the normal way to delegate in this mode: ' +
        'every piece of work gets a named ticket, and the title is what the user sees in the sidebar for that child conversation. ' +
        'Use it for anything that needs doing rather than asking; use the bare `subagent*` tools only when you need an option this tool does not expose. ' +
        'The worker runs in the background and returns its result to you; it does not see this conversation, so the brief must be self-contained.',
      parameters: PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        return createTicket(args, exec)
      },
    })
    ctx.logger?.info?.(
      `dsh-subagent-tree: registered "${TOOL_NAME}" \u2014 delegation is ticket-shaped and titles reach the sidebar [TICKET-CREATE-ENGAGED]`,
    )
  } catch (error) {
    warn(
      `registering "${TOOL_NAME}" failed: ${error instanceof Error ? error.message : String(error)} \u2014 ` +
        'the bare delegation tools still work, tickets are unavailable [TICKET-CREATE-SKIPPED reason=register-threw]',
    )
  }
}
