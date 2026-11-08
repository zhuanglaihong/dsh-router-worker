/**
 * dsh-subagent-tree — 浏览器半（client bundle）。
 *
 * 一句话：把「子代理会话」画成主会话在左侧列表里的**缩进子树**，带连接线、状态
 * 文字、一键收起，并且**对任何 agent 模式生效**（标准 / Multitask / 自定义
 * preset 都一样），**不依赖任何主题插件**（claude style、默认皮肤、以后的新主题
 * 都不影响）。
 *
 * ── 为什么要用 DOM 注入，而不是注册插槽 ─────────────────────────────────────
 * 宿主的左侧会话列表把整个浏览区域声明成 single 独占插槽
 * （`sidebar.workspaces`，replaceRisk "shadows-shipped-ui"），插件的 slots 挂不
 * 进去；它底下只有 `sidebar.session.row.leading / trailing / hover` 这几个
 * **装饰已有行**的子槽，没有任何「在行下面再画一行」的座位。所以唯一不改宿主源码
 * 的办法，是像 dsh-superagent-local 那样，拿 `data-row-key` 这种**业务属性**当
 * 锚点（不是 class —— class 带构建哈希，换主题就变），自己把子行插进去。
 *
 * ── 为什么对主题免疫 ─────────────────────────────────────────────────────────
 * 1. 锚点只用 `[data-row-key^="session:"]`，这是宿主的数据属性，任何主题都保留；
 * 2. 颜色只用 `--dsw-alias-*` / `currentColor` 这类**语义变量**，不写死色值；
 * 3. 自己的样式全部挂在 `[data-dsh-subagent-tree]` 前缀下，作用域收敛，不污染
 *    宿主的其它 DOM。
 *
 * ── 为什么对所有模式生效 ─────────────────────────────────────────────────────
 * 父子关系不来自 Multitask，而来自宿主自己的会话摘要：`origin === 'subagent'`
 * + `parentId`。凡是子代理（不管是谁派的、什么模式派的）都带这两个字段，所以
 * 标准模式下的「面试复盘」那种会话也会被收进树里。
 *
 * ⚠️ 本文件必须先于 package.json 的 `dsh.client` 声明存在：声明了 `dsh.client`
 * 而 `exports["./client"]` 指不到文件时，客户端模块系统会抛
 * MissingClientBundleError，整个 clientModules fiber FAILED，Web 插件名单全挂。
 */

window.__ModuleLoader__.load({
	id: "dsh-subagent-tree",
	factory: (require) => {
		// ⚠️ lazy-CJS 契约：factory 只拿到 require，`module` / `exports` 必须自己建，
		// 而且两个都要建 —— 只建 module 而在内部用 `exports.apply = ...` 会抛
		// `ReferenceError: exports is not defined`（我第一次就踩了这个坑）。
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		/**
		 * React 只给设置页用；侧栏树是纯 DOM，不需要它。
		 * 包在 try/catch 里：万一某个宿主版本没把 react 放进种子表，
		 * 设置页不挂即可，绝不能让整个 client bundle 抛错（那会重现
		 * 0.1.0 的启动失败）。react 缺席时 mountSettings() 直接返回。
		 */
		let react = null;
		try { react = require("react"); } catch { react = null; }

		/** 本地化命名空间。用自有 NS，避免与官方 "subagent" 的 zh/en 冲突。 */
		const NS = "dsh-subagent-tree";

		/** 折叠状态在 localStorage 里的键。 */
		const STORAGE_KEY = "dsh-subagent-tree:collapsed";

		/** 「显示更早的子对话」状态（默认收起，只画最近几条）。 */
		const EXPANDED_KEY = "dsh-subagent-tree:expanded";

		/**
		 * 默认只画最近几条子对话。
		 *
		 * 用户反馈（m02555）：「如果每次都重新分配子智能体会不会越累积越多，浪费空间？」
		 * 会。派活就是新建会话，旧的永远保留（这是宿主 append-only 的行为，不覆盖）。
		 * 真机数据：一次「面试复盘」就留下 4 条子会话。所以超过这个数就折起来，
		 * 只留「还有 N 条更早的子对话」一行。
		 */
		const MAX_VISIBLE = 3;

		/** 我们自己画的东西都带这个属性，便于整体清理与幂等重建。 */
		const ATTR = "data-dsh-subagent-tree";

		/** 子会话行的锚点标记：宿主行后面紧跟的那块子树。 */
		const TREE_ATTR = "data-dsh-subagent-tree-of";

		const zh = {
			"tree.children": "子对话",
			"tree.collapse": "收起子对话",
			"tree.expand": "展开子对话",
			"tree.more": "还有 {count} 条更早的子对话",
			"tree.less": "收起更早的 {count} 条",
			"tree.running": "运行中",
			"tree.idle": "已结束",
			"tree.open": "打开这条子对话",
			"tree.hint": "子代理会话，点击查看它的过程记录",
			"tree.childrenCount": "{count} 条子对话",
			/* Phase 3：工单状态条。排队中的活还没有子会话（没派出去），
			   在侧栏树里本来是「看不见」的 —— 这行就是把它们补上。 */
			"tree.runningCount": "{count} 运行中",
			"tree.queuedCount": "{count} 排队",
			"tree.queueHint": "排队：",
			"tree.ticketHint": "工单来自 Router 项目经理模式；排队中的工单还没有对应的子对话",
		};

		const en = {
			"tree.children": "Sub-conversations",
			"tree.collapse": "Collapse sub-conversations",
			"tree.expand": "Expand sub-conversations",
			"tree.more": "{count} earlier sub-conversations",
			"tree.less": "Hide the {count} earlier",
			"tree.running": "running",
			"tree.idle": "finished",
			"tree.open": "Open this sub-conversation",
			"tree.hint": "Sub-agent session — click to see its process record",
			"tree.childrenCount": "{count} sub-conversations",
			"tree.runningCount": "{count} running",
			"tree.queuedCount": "{count} queued",
			"tree.queueHint": "queued: ",
			"tree.ticketHint": "Tickets come from the Router preset; queued tickets have no sub-conversation yet",
		};

		/** 一次注入的样式表（主题变量优先，缺了也还有退路）。 */
		const CSS = `
/* ── 结构无关的渲染约定（m06509）──────────────────────────────────────────────
   旧实现把子树用 display:contents 挂在宿主行的「内部兄弟」位置，还往宿主行里塞
   绝对定位箭头、改 padding、改标题 margin。原生 DSH 勉强能用，但 claude-style 这类
   皮肤会给每个会话行套一层 box、按日期把 box 搬来搬去、往行里插 date-chip、还会
   整块隐藏 box —— 所有基于「行长什么样」的假设全崩（截图：主行变空灰条、子行与
   引导线断成两截）。

   现在只认一条：**宿主行一个字节都不动**。只依赖它稳定的
   [data-row-key^="session:"] 标记，把整块子树作为该行最外层单行容器的兄弟插在后面；
   箭头、状态条、子行全部画在自己的块里。缩进用 em / 主题字号计算，不写死 48/64px。
   皮肤重排或隐藏 box 后，holdersAligned() 会发现错位并重新挂靠（见 install()）。 */
[${ATTR}-of] {
  display: contents;
  /* 用主题字号算出统一的缩进（calc 结果被继承，所有子行拿到同一个像素值） */
  /* 三档全部按当前主题字号算，任何皮肤/密度下比例一致：
     引导线落在主行标题起点附近（4em），子行文字再往右 2em，
     横枝宽度正好 = 两者之差，于是「线 → 文字」永远严丝合缝。 */
  --sat-line: calc(var(--dsw-font-size-sm, 12px) * 4);
  --sat-indent: calc(var(--dsw-font-size-sm, 12px) * 6);
  --sat-branch: calc(var(--sat-indent) - var(--sat-line));
}
[${ATTR}-ctrl] {
  display: flex; align-items: center; gap: 6px;
  padding: 1px 8px 1px var(--sat-line);
  font-size: var(--dsw-font-size-xs, 11px);
  line-height: 1.6;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor));
  cursor: pointer; user-select: none; opacity: .85;
}
[${ATTR}-ctrl]:hover { opacity: 1; color: var(--dsw-alias-label-primary, inherit); }
[${ATTR}-ctrl-label] { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[${ATTR}-toggle] {
  display: inline-flex; align-items: center; justify-content: center;
  flex: 0 0 auto;
  width: 16px; height: 16px;
  border: 0; padding: 0; margin: 0;
  background: transparent; color: inherit; cursor: pointer; opacity: .8;
  border-radius: 4px;
}
[${ATTR}-toggle]:hover { opacity: 1; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); }
[${ATTR}-toggle] > svg { transition: transform .12s ease; }
[${ATTR}-toggle][data-collapsed="true"] > svg { transform: rotate(-90deg); }
[${ATTR}-row] {
  position: relative;
  display: flex; align-items: center; gap: 6px;
  padding: 3px 8px 3px var(--sat-indent);
  min-height: 22px;
  font-size: var(--dsw-font-size-sm, 12px);
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, currentColor);
  border-radius: 6px;
  cursor: pointer; user-select: none; opacity: .92;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[${ATTR}-row]:hover {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
  color: var(--dsw-alias-label-primary, inherit);
}
[${ATTR}-row][data-running="true"] { color: var(--dsw-alias-label-primary, inherit); }
/* 引导线：竖线在 --sat-line，横枝向右伸 --sat-branch，全部 currentColor 淡化跟主题走。 */
[${ATTR}-row]::before {
  content: ""; position: absolute;
  left: var(--sat-line); top: 0; bottom: 0;
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
}
[${ATTR}-row]::after {
  content: ""; position: absolute;
  left: var(--sat-line); top: 50%; width: var(--sat-branch);
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
}
[${ATTR}-row][data-last="true"]::before { bottom: 50%; }
[${ATTR}-dot] {
  flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary, rgba(127,127,127,.6));
}
[${ATTR}-row][data-running="true"] [${ATTR}-dot] { background: var(--dsw-alias-brand-primary, #4c8dff); }
[${ATTR}-label] { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[${ATTR}-status] {
  flex: 0 0 auto; font-size: var(--dsw-font-size-xs, 11px);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor));
  opacity: .8;
}
[${ATTR}-more] {
  display: flex; align-items: center;
  padding: 2px 8px 2px var(--sat-indent);
  font-size: var(--dsw-font-size-xs, 11px);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor));
  cursor: pointer; user-select: none; opacity: .8;
}
[${ATTR}-more]:hover { opacity: 1; color: var(--dsw-alias-label-primary, inherit); }
[${ATTR}-more][data-expanded="1"] { opacity: .55; }
[${ATTR}-more][data-expanded="1"]:hover { opacity: 1; }
[${ATTR}-bar] {
  display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
  padding: 2px 8px 2px var(--sat-indent);
  font-size: var(--dsw-font-size-xs, 11px);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor));
  opacity: .85;
}
[${ATTR}-bar-chip] { display: inline-flex; align-items: center; gap: 4px; }
[${ATTR}-bar-chip]::before {
  content: ""; width: 5px; height: 5px; border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary, rgba(127,127,127,.6));
}
[${ATTR}-bar-chip][data-kind="running"]::before { background: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary, #4c8dff)); }
[${ATTR}-bar-chip][data-kind="queued"]::before { background: var(--dsw-alias-state-warn-primary, #d9a441); }
[${ATTR}-queue] {
  padding: 1px 8px 1px var(--sat-indent);
  font-size: var(--dsw-font-size-xs, 11px);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor));
  opacity: .7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
`;

		/** 读折叠状态（按父会话 id 记，Map<string, boolean>）。 */
		function readCollapsed() {
			try {
				const raw = localStorage.getItem(STORAGE_KEY);
				if (!raw) return new Map();
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return new Map();
				const map = new Map();
				for (const [k, v] of Object.entries(parsed)) if (v === true) map.set(k, true);
				return map;
			} catch {
				return new Map();
			}
		}

		/** 写折叠状态。只存「被收起的」，默认全展开，数据量小。 */
		function writeCollapsed(map) {
			try {
				const out = {};
				for (const [k, v] of map) if (v) out[k] = true;
				localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
			} catch {
				/* 隐私模式下 localStorage 可能抛错，静默降级为「本次会话内有效」 */
			}
		}

		/** 读「显示全部更早的子对话」状态（按父会话 id 记）。 */
		function readExpanded() {
			try {
				const raw = localStorage.getItem(EXPANDED_KEY);
				if (!raw) return new Map();
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return new Map();
				const map = new Map();
				for (const [k, v] of Object.entries(parsed)) if (v === true) map.set(k, true);
				return map;
			} catch {
				return new Map();
			}
		}

		/** 写「显示全部」状态。只存展开过的那些。 */
		function writeExpanded(map) {
			try {
				const out = {};
				for (const [k, v] of map) if (v) out[k] = true;
				localStorage.setItem(EXPANDED_KEY, JSON.stringify(out));
			} catch {
				/* 同上，静默 */
			}
		}

		/** 主会话 id → 直接子会话列表（按创建时间排序，排除 Side: 旁支）。 */
		function childrenOf(byId, parentId) {
			const out = [];
			for (const summary of Object.values(byId ?? {})) {
				if (!summary || summary.origin !== "subagent") continue;
				if (summary.parentId !== parentId) continue;
				// 宿主把「侧边对话」也记成 subagent 子会话，标题以 "Side: " 开头；
				// 那不是 agent 派出去的活，留在树里只会误导。
				if (typeof summary.displayTitle === "string" && summary.displayTitle.startsWith("Side: ")) continue;
				out.push(summary);
			}
			out.sort((a, b) => {
				const ta = typeof a.createdAt === "number" ? a.createdAt : 0;
				const tb = typeof b.createdAt === "number" ? b.createdAt : 0;
				return ta - tb;
			});
			return out;
		}

		/** 摘要太长就截断，行里只放得下一行字。 */
		function clip(text, max) {
			const value = typeof text === "string" ? text.trim().replace(/\s+/g, " ") : "";
			if (!value) return "";
			return value.length > max ? value.slice(0, max - 1) + "…" : value;
		}

		/**
		 * 主会话视角的子代理清单：`subagentCatalog` 投影。
		 *
		 * 这是宿主官方给父会话看的「我派出去哪些子代理」目录，条目形如
		 * `{ id, createdAt, mode: "one-shot" | "continuable", label? }`。
		 * 关键是 `label`：这是**派单时起的短名**（例如「山东云鼎问题书面化」），
		 * 比 `displayTitle` 干净得多 —— 后者在没有短名时会退化成任务书正文，
		 * 于是侧栏上出现「You are a worker executing…」这种看不懂的一长串。
		 */
		function catalogOf(snapshot, parentId) {
			try {
				const entries = snapshot?.projectionsBySession?.[parentId]?.values?.subagentCatalog;
				return Array.isArray(entries) ? entries : [];
			} catch {
				return [];
			}
		}

		/** 子会话 id → 短名（没有就用空串）。 */
		function labelIndex(catalog) {
			const map = new Map();
			for (const entry of catalog ?? []) {
				if (!entry || typeof entry.id !== "string") continue;
				const label = typeof entry.label === "string" ? entry.label.trim() : "";
				if (label) map.set(entry.id, label);
			}
			return map;
		}

		/** 三角形图标（折叠箭头），用 currentColor，所以跟主题走。 */
		function chevron() {
			const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			svg.setAttribute("viewBox", "0 0 16 16");
			svg.setAttribute("width", "10");
			svg.setAttribute("height", "10");
			svg.setAttribute("aria-hidden", "true");
			const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
			path.setAttribute("d", "M4.5 6.5 L8 10 L11.5 6.5");
			path.setAttribute("fill", "none");
			path.setAttribute("stroke", "currentColor");
			path.setAttribute("stroke-width", "1.6");
			path.setAttribute("stroke-linecap", "round");
			path.setAttribute("stroke-linejoin", "round");
			svg.appendChild(path);
			return svg;
		}

		/**
		 * 打开一条子会话。
		 *
		 * 优先走宿主自己的「子对话」右侧标签页（`sidebarRight.openResource` +
		 * `dsh-resource://subagentchat/session/<child>?parent=<parent>&mode=<mode>`），
		 * 因为这是唯一能**在不离开当前主对话**的前提下看子代理过程的官方通道；
		 * 宿主没有这个标签页类型时，退回到普通会话跳转（会把主视图切走）。
		 */
		function openChild(ctx, parentId, child) {
			const mode = child.mode === "continuable" || child.mode === "one-shot" ? child.mode : "unknown";
			try {
				const right = ctx.get?.("sidebarRight");
				const tabs = ctx.get?.("sidebarRightTabs");
				if (right && typeof right.openResource === "function" && (!tabs || tabs.get?.("subagentchat") !== void 0)) {
					const query = new URLSearchParams({ parent: parentId, mode });
					const address = `dsh-resource://subagentchat/session/${encodeURIComponent(child.id)}?${query}`;
					right.openResource(address, { kind: "subagentchat", preferNewPane: true });
					return;
				}
			} catch {
				/* 落到下面的普通跳转 */
			}
			try {
				const workspace = ctx.uiWorkspace ?? ctx.get?.("uiWorkspace");
				if (workspace && typeof workspace.openSession === "function") {
					// 注意：openSession 收的是 SessionTarget（通常是会话 id 字符串），
					// 不是 {id} 对象 —— 传对象宿主会静默不跳。
					workspace.openSession(child.id);
					return;
				}
			} catch {
				/* 再退一级 */
			}
			try {
				sessionService(ctx)?.open?.(child.id);
			} catch {
				/* 实在打不开就静默，用户点第二次通常会成功（目录还没 ready） */
			}
		}

		/** 造一行子会话 DOM。 */
		function buildRow(ctx, t, parentId, child, index, isLast, collapsible, name) {
			const row = document.createElement("div");
			row.setAttribute(ATTR + "-row", "1");
			row.setAttribute("role", "button");
			row.setAttribute("tabindex", "0");
			row.dataset.running = child.running === true ? "true" : "false";
			row.dataset.last = isLast ? "true" : "false";

			const dot = document.createElement("span");
			dot.setAttribute(ATTR + "-dot", "1");
			row.appendChild(dot);

			// 名字 = 编号 + 短名（用户选的 B 方案）。
			// 短名优先取宿主 `subagentCatalog` 里的 `label`（派单时起的名字），
			// 没有再退回 `displayTitle`，最后才退到 id 前 8 位。
			const label = document.createElement("span");
			label.setAttribute(ATTR + "-label", "1");
			const raw = typeof name === "string" ? name : child.displayTitle;
			const title = clip(raw, 40) || child.id.slice(0, 8);
			label.textContent = `#${index + 1} ${title}`;
			row.appendChild(label);

			// 悬停时给出完整信息：短名可能被截断，而且要让人能分清是哪一次派单。
			const full = typeof child.displayTitle === "string" ? clip(child.displayTitle, 200) : "";
			row.setAttribute(
				"title",
				full && full !== title ? `${title}\n${full}\n${t("tree.hint")}` : `${title}\n${t("tree.hint")}`,
			);

			const status = document.createElement("span");
			status.setAttribute(ATTR + "-status", "1");
			status.textContent = child.running === true ? t("tree.running") : t("tree.idle");
			row.appendChild(status);

			row.addEventListener("click", (event) => {
				event.preventDefault();
				event.stopPropagation();
				openChild(ctx, parentId, child);
			});
			row.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				openChild(ctx, parentId, child);
			});

			if (collapsible) row.setAttribute("data-collapsible", "true");
			return row;
		}

		/**
		 * 收起/展开箭头 —— **只画在我们自己的子树块里**，绝不塞进宿主行。
		 */
		function buildToggle(t, parentId, collapsed) {
			const button = document.createElement("button");
			button.type = "button";
			button.setAttribute(ATTR + "-toggle", "1");
			button.dataset.parent = parentId;
			button.dataset.collapsed = collapsed ? "true" : "false";
			button.title = collapsed ? t("tree.expand") : t("tree.collapse");
			button.setAttribute("aria-label", button.title);
			button.setAttribute("aria-expanded", collapsed ? "false" : "true");
			button.appendChild(chevron());
			return button;
		}

		/**
		 * 把子树挂到宿主行**后面**，但始终留在 `row.parentElement` 里面 —— 结构无关，
		 * 只认稳定的 [data-row-key^="session:"]，不认任何 class / data-part / 像素。
		 *
		 * 为什么不往上爬到「box 的兄弟」：claude-style 的 dateGroups 是拿
		 * `row.parentElement` 当 box，用 `appendChild(box)` 整体搬动、用
		 * `box.style.display="none"` 整体隐藏。holder 只有作为这个 box 的**子节点**
		 * 才会跟着一起搬、一起藏；放到 box 外面当兄弟，重排一次就被落在原地 →
		 * 父行与引导线断成两截（用户 m06509 的截图）。
		 *
		 * 原生 DSH：row.parentElement 就是列表容器，holder 作为行的 next sibling 正好
		 * 紧跟其后。两种结构下都是同一个动作：row.insertAdjacentElement("afterend")。
		 * 关键是**绝不改宿主行本身**（老实现往行里塞绝对定位箭头、改 padding、改标题
		 * margin，遇到会往行里插 date-chip 的皮肤就把标题推没了 → 空灰条）。
		 */
		function attachHolder(row, holder) {
			row.insertAdjacentElement("afterend", holder);
		}

		/**
		 * 子树块的第一行：箭头 + 「N 条子对话」。整行都属于我们，任何皮肤都改不到它；
		 * 点箭头或文字都能收起/展开。折叠态下这一行也是唯一的入口。
		 */
		function buildControlLine(ctx, t, parentId, collapsed, count) {
			const line = document.createElement("div");
			line.setAttribute(ATTR + "-ctrl", "1");
			line.setAttribute("role", "button");
			line.setAttribute("tabindex", "0");
			line.appendChild(buildToggle(t, parentId, collapsed));
			const label = document.createElement("span");
			label.setAttribute(ATTR + "-ctrl-label", "1");
			label.textContent = t("tree.childrenCount", { count });
			line.appendChild(label);
			const toggle = (event) => {
				event.preventDefault();
				event.stopPropagation();
				const map = readCollapsed();
				if (map.get(parentId) === true) map.delete(parentId);
				else map.set(parentId, true);
				writeCollapsed(map);
				render(ctx, t);
			};
			line.addEventListener("click", toggle);
			line.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") toggle(event);
			});
			return line;
		}

		/**
		 * 皮肤重排之后，每块子树是否还和自己的父行待在同一个容器里？
		 *
		 * signatureOf() 只看会话数据；React 把会话行整体换成新 DOM（切工作区、皮肤
		 * 接管列表、日期分组重挂载）时指纹可能完全不变 → draw() 会跳过重画，子树就
		 * 留在被摘掉的旧容器里。这里补一刀结构检查：holder 必须仍连着文档、且与父行
		 * 同一个 parentElement。用「同容器」而不是「必须是 nextElementSibling」，是为了
		 * 不跟会往 box 里插 title/header 的皮肤互相触发重画（避免 ping-pong）。
		 */
		function holdersAligned() {
			const rows = document.querySelectorAll('[data-row-key^="session:"]');
			const byKey = new Map();
			for (const row of rows) byKey.set(row.getAttribute("data-row-key"), row);
			const holders = document.querySelectorAll(`[${TREE_ATTR}]`);
			for (const holder of holders) {
				const parentId = holder.getAttribute(TREE_ATTR);
				const row = parentId ? byKey.get("session:" + parentId) : null;
				if (!row) return false;                       // 父行不在可见列表里了
				if (!holder.isConnected) return false;        // 容器被皮肤整体换掉
				if (holder.parentElement !== row.parentElement) return false; // 与父行分家
			}
			return true;
		}

		/**
		 * 「还有 N 条更早的子对话」/「收起更早的 N 条」。
		 *
		 * 用户反馈（m02555）：「如果每次都重新分配子智能体会不会越累积越多，浪费空间？」
		 * 会话本身是 append-only 的（每派一次活就是一条新会话，旧的不会被覆盖），
		 * 所以列表会一直变长。这里默认只画**最近 MAX_VISIBLE 条**，更早的折成一行
		 * 提示；点一下才全展开（每个主会话单独记状态，存在 localStorage）。
		 *
		 * 用户反馈（m04474）：「点开展开之后似乎又没有折叠的按钮，每次打开那个主对话
		 * 就显示所有的子对话了」—— 展开是个**一直生效**的开关，之前只写了「打开」没写
		 * 「关上」。现在同一行兼任两个方向：折叠时是「还有 N 条」，展开后变成
		 * 「收起更早的 N 条」，点回去就把开关关掉。不额外占一行（用户明确说过不要
		 * 那种占满一行的全局按钮）。
		 */
		function buildMore(ctx, t, parentId, hidden, expanded) {
			const row = document.createElement("div");
			row.setAttribute(ATTR + "-more", "1");
			row.setAttribute("role", "button");
			row.setAttribute("tabindex", "0");
			row.setAttribute("data-expanded", expanded ? "1" : "0");
			row.textContent = expanded
				? t("tree.less", { count: hidden })
				: t("tree.more", { count: hidden });
			const toggle = (event) => {
				event.preventDefault();
				event.stopPropagation();
				const map = readExpanded();
				if (expanded) map.delete(parentId);
				else map.set(parentId, true);
				writeExpanded(map);
				render(ctx, t);
			};
			row.addEventListener("click", toggle);
			row.addEventListener("keydown", (event) => {
				if (event.key === "Enter" || event.key === " ") toggle(event);
			});
			return row;
		}

		/**
		 * 把整棵树重画一遍（幂等）。
		 *
		 * 每次会话列表变化、DOM 变化都调它：先清掉上一轮我们插进去的节点，再按当前
		 * 快照重建。这样不会出现「宿主重渲染了行、我们的节点变成孤儿」的问题。
		 */
		/** 取客户端会话服务：优先走 cordis 的 `get`，退回直接属性（两种宿主版本都见过）。 */
		function sessionService(ctx) {
			try {
				const viaGet = ctx.get?.("sessions");
				if (viaGet) return viaGet;
			} catch {
				/* ctx.get 在部分宿主版本里会抛「没有 inject」，退回属性访问 */
			}
			try {
				return ctx.sessions ?? null;
			} catch {
				return null;
			}
		}

		/* ────────────────────────────────────────────────────────────────────────
		 * Phase 3：工单状态条（轻量版）
		 *
		 * 侧栏树本来只画「已经存在的子会话」。但 Router 模式里排队中的工单还没派
		 * 出去 —— 没有子会话，于是在树里完全看不见。用户 m06084 选了「轻量版」：
		 * 不另开面板，就在主会话行下面补一条汇总（N 运行中 / M 排队）+ 排队项标题。
		 *
		 * 数据在宿主进程的 sqlite 里，renderer 进程读不到，所以宿主开了个只读 GET
		 * 路由（见 lib/index.js 的 `ticket status route`），这里定时拉。
		 *
		 * ⚠️ URL 必须相对 `document.baseURI` 解析：Electron 页面是 `dsh-app://app/`，
		 * shell 把非静态路径转发到 Host 同源；用注入的 `streamBaseUrl`（Host 真实
		 * origin）会变成跨源请求，而插件路由没有 CORS 头 → "Failed to fetch"。
		 * 这是 dsh-better-sidebar 的 `hostRouteUrl()` 踩过的坑，照它的写法来。
		 * ──────────────────────────────────────────────────────────────────────── */
		const TICKETS_PATH = "plugins/dsh-subagent-tree/tickets";
		const TICKET_POLL_MS = 2_500;

		/** parentId -> { running, queued, queuedTitles }。轮询成功才整体替换。 */
		let ticketSnapshot = Object.create(null);
		/** 上一次的紧凑指纹：变了才触发重画，也进 signatureOf() 防止被提前 return。 */
		let ticketSig = "";

		function ticketStateOf(parentId) {
			const v = ticketSnapshot[parentId];
			return v && (v.running > 0 || v.queued > 0) ? v : null;
		}

		function ticketRouteUrl() {
			let base = "";
			try { base = document.baseURI || ""; } catch { base = ""; }
			const url = new URL(base || "http://dsh.internal/", "http://dsh.internal/");
			url.search = "";   // launch token 不能带进路由
			url.hash = "";
			if (!url.pathname.endsWith("/")) url.pathname += "/";
			return new URL(TICKETS_PATH, url.href).href;
		}

		/**
		 * 定时拉工单。返回注销器。
		 * 失败时**保留旧快照**：路由还没注册、应用正在退出、网络抖一下都不该让
		 * 状态条闪成空白。只有拿到 `{ok:true,value:[...]}` 才更新。
		 */
		function startTicketPolling(onChange) {
			let stopped = false;
			let timer = null;
			let controller = null;
			const tick = async () => {
				if (stopped) return;
				try {
					controller = new AbortController();
					const res = await fetch(ticketRouteUrl(), {
						signal: controller.signal,
						headers: { accept: "application/json" },
					});
					const body = await res.json();
					const rows = body && body.ok === true && Array.isArray(body.value) ? body.value : [];
					const next = Object.create(null);
					for (const r of rows) {
						if (!r || typeof r !== "object") continue;
						const parent = String(r.parent ?? "");
						if (!parent) continue;
						const slot = next[parent] || (next[parent] = { running: 0, queued: 0, queuedTitles: [] });
						if (r.status === "running") slot.running += 1;
						else if (r.status === "queued") {
							slot.queued += 1;
							slot.queuedTitles.push(String(r.title ?? ""));
						}
					}
					const sig = JSON.stringify(next);
					if (sig !== ticketSig) {
						ticketSig = sig;
						ticketSnapshot = next;
						onChange();
					}
				} catch {
					/* 静默重试：不把旧快照清掉，也不把异常抛回宿主 */
				} finally {
					controller = null;
					if (!stopped) timer = setTimeout(tick, TICKET_POLL_MS);
				}
			};
			tick();
			return () => {
				stopped = true;
				if (timer) clearTimeout(timer);
				try { controller?.abort(); } catch { /* 已结束 */ }
			};
		}

		/** 造一条「N 运行中 / M 排队」汇总。 */
		function buildTicketBar(t, state) {
			const bar = document.createElement("div");
			bar.setAttribute(ATTR + "-bar", "1");
			bar.title = t("tree.ticketHint");
			const chip = (kind, text) => {
				const span = document.createElement("span");
				span.setAttribute(ATTR + "-bar-chip", "1");
				span.dataset.kind = kind;
				span.textContent = text;
				bar.appendChild(span);
			};
			if (state.running > 0) chip("running", t("tree.runningCount", { count: state.running }));
			if (state.queued > 0) chip("queued", t("tree.queuedCount", { count: state.queued }));
			return bar;
		}

		/** 造一行排队工单标题（这类工单还没有子会话，树里本来完全看不见）。 */
		function buildQueueRow(t, title) {
			const line = document.createElement("div");
			line.setAttribute(ATTR + "-queue", "1");
			const text = String(title || "");
			line.textContent = t("tree.queueHint") + clip(text, 40);
			line.title = text;
			return line;
		}

		function render(ctx, t) {
			const doc = document;
			const list = sessionService(ctx)?.list;
			const snapshot = list?.getSnapshot?.();
			const byId = snapshot?.byId ?? {};

			// 1) 清掉上一轮产物（子树容器 + 主行里的箭头 + 「更早的子对话」提示）
			for (const node of doc.querySelectorAll(`[${TREE_ATTR}]`)) node.remove();
			for (const node of doc.querySelectorAll(`[${ATTR}-toggle]`)) node.remove();
			for (const node of doc.querySelectorAll(`[${ATTR}-ctrl]`)) node.remove();
			for (const node of doc.querySelectorAll(`[${ATTR}-more]`)) node.remove();
			for (const node of doc.querySelectorAll(`[${ATTR}-bar]`)) node.remove();
			for (const node of doc.querySelectorAll(`[${ATTR}-queue]`)) node.remove();
			// 宿主行一个字节都不动（m06509）：没有内联 padding / margin 需要还原。

			const collapsed = readCollapsed();
			const expanded = readExpanded();

			// 2) 找到左侧列表里所有可见的主会话行
			const rows = doc.querySelectorAll('[data-row-key^="session:"]');
			let touched = 0;
			const treeNodes = [];

			for (const row of rows) {
				const key = row.getAttribute("data-row-key") ?? "";
				const parentId = key.slice("session:".length);
				if (!parentId) continue;
				const children = childrenOf(byId, parentId);
				// Phase 3：排队中的工单**还没有子会话**，但这条主会话行现在也值得画
				// 一条状态条 —— 这正是「轻量版看板」要补的缺口。
				const ticketState = ticketStateOf(parentId);
				const hasChildren = children.length > 0;
				const hasTickets = ticketState != null;
				if (!hasChildren && !hasTickets) continue;

				const names = labelIndex(catalogOf(snapshot, parentId));
				const isCollapsed = collapsed.get(parentId) === true;

				// 3a) 只有真的有子对话时才画收起/展开箭头（排队工单没有可折叠的行）
				// 3d) 子树挂在宿主行后面、且留在 row.parentElement 里（见 attachHolder）。
				//     皮肤搬动/隐藏那个容器时，子树跟着一起动，不会断线。
				const holder = doc.createElement("div");
				holder.setAttribute(TREE_ATTR, parentId);
				// 注：TREE_ATTR 与 ATTR + "-of" 是同一个字符串，只写一次，值就是 parentId。
				// 第一行永远是我们自己的收起/展开控件（只画在有子对话时）。
				if (hasChildren) {
					holder.appendChild(buildControlLine(ctx, t, parentId, isCollapsed, children.length));
				}

				// 3b') 状态条是父会话的汇总，收起时也保留 —— 收起 = 只看汇总，不看明细。
				if (hasTickets) holder.appendChild(buildTicketBar(t, ticketState));

				if (isCollapsed) {
					attachHolder(row, holder);
					treeNodes.push(holder);
					touched += 1;
					continue;
				}

				// 3b'') 排队工单逐条列出：它们没有子会话，树里本来完全看不见。
				if (hasTickets) {
					for (const title of ticketState.queuedTitles) {
						holder.appendChild(buildQueueRow(t, title));
					}
				}

				// 3c) 子对话太多时只画最近的几条（按时间正序，所以取尾部）
				//     用户反馈：每派一次活就多一条会话，列表会越堆越长。
				const showAll = expanded.get(parentId) === true;
				const folded = children.length > MAX_VISIBLE ? children.length - MAX_VISIBLE : 0;
				const hidden = showAll ? 0 : folded;
				const visible = hidden === 0 ? children : children.slice(hidden);

				// 展开态也要保留这一行 —— 它同时是「收起」的入口。
				if (folded > 0) holder.appendChild(buildMore(ctx, t, parentId, folded, showAll));
				visible.forEach((child, index) => {
					holder.appendChild(
						buildRow(
							ctx,
							t,
							parentId,
							child,
							hidden + index,
							hidden + index === children.length - 1,
							true,
							names.get(child.id),
						),
					);
				});
				attachHolder(row, holder);
				treeNodes.push(holder);
				touched += 1;
			}

			return { touched, nodes: treeNodes };
		}

		/** 装上 MutationObserver：宿主每次重画列表，我们就在下一帧跟进。 */
		function install(ctx, t) {
			const doc = document;

			// 样式表只插一次
			const STYLE_ID = "dsh-subagent-tree-style";
			if (!doc.getElementById(STYLE_ID)) {
				const style = doc.createElement("style");
				style.id = STYLE_ID;
				style.textContent = CSS;
				(doc.head ?? doc.documentElement).appendChild(style);
			}

			let scheduled = false;
			const observer = new MutationObserver(() => schedule());
			const target = doc.body ?? doc.documentElement;

			/**
			 * ⚠️ 关键：我们自己也在改 DOM，如果观察器一直连着，每画一次就会触发自己
			 * 一次，形成 60fps 的重画死循环。所以**先断开、再画、再连上** —— 断开期
			 * 间的变更记录会被丢弃，天然不会被自己唤醒。
			 */
			/**
			 * 当前「应该画成什么样」的指纹。
			 *
			 * 宿主每吐一个字都会改 DOM，观察器就会调我们一次；如果每次都真的删了
			 * 重画，整棵树在回答流式输出期间会 60fps 抖动。所以先比指纹：只有
			 * 行集合、运行状态、折叠状态或行数任一变化时才重画。
			 */
			const signatureOf = () => {
				const snapshot = sessionService(ctx)?.list?.getSnapshot?.();
				const byId = snapshot?.byId ?? {};
				const collapsed = readCollapsed();
				const expanded = readExpanded();
				const rows = document.querySelectorAll('[data-row-key^="session:"]');
				const parts = [];
				for (const row of rows) {
					const key = row.getAttribute("data-row-key") ?? "";
					const parentId = key.slice("session:".length);
					if (!parentId) continue;
					const kids = childrenOf(byId, parentId);
					// Phase 3：工单状态条也是这一行要画的内容。排队工单**没有**子会话，
					// 所以这里不能再用 kids.length === 0 就把整行跳过。
					const ts = ticketStateOf(parentId);
					if (kids.length === 0 && ts == null) continue;
					// 短名也要进指纹：主智能体后补/改了 label 时行文字要跟着变。
					const names = labelIndex(catalogOf(snapshot, parentId));
					const ticketPart = ts
						? ":t" + ts.running + "/" + ts.queued + "/" + ts.queuedTitles.map((x) => x.slice(0, 16)).join(",")
						: ":t-";
					parts.push(
						parentId +
							"|" +
							(collapsed.get(parentId) === true ? "c" : "e") +
							"|" +
							(expanded.get(parentId) === true ? "x" : "-") +
							"|" +
							kids.length +
							"|" +
							kids
								.map(
									(kid) =>
										kid.id +
										":" +
										(kid.running === true ? "r" : "d") +
										":" +
										(names.get(kid.id) ?? "").slice(0, 24),
								)
								.join(",") +
							ticketPart,
					);
				}
				// 全局工单指纹也进来：某个父行当前不在可见列表里时，工单数量变化同样
				// 不该被「指纹没变」吞掉（等它滚回可见区域能立刻画对）。
				return parts.join(";") + "||" + ticketSig;
			};

			let drawnSignature = null;

			const draw = () => {
				let signature = "";
				try {
					signature = signatureOf();
				} catch {
					signature = "";
				}
				// 指纹没变、而且上一轮的节点都还活着、且仍与父行同容器 → 什么都不做
			if (signature === drawnSignature) {
				const alive =
					target.querySelectorAll(`[${TREE_ATTR}]`).length > 0 ||
					signature === "";
				// 指纹只看数据；皮肤把会话行整体换成新 DOM 时指纹不变，
				// 靠 holdersAligned() 发现「子树与父行分家」并强制重画（m06509）。
				if (alive && holdersAligned()) return;
			}
				observer.disconnect();
				try {
					render(ctx, t);
					drawnSignature = signature;
				} catch (error) {
					console.error("[dsh-subagent-tree] render failed:", error);
				} finally {
					observer.observe(target, { childList: true, subtree: true });
				}
			};

			const schedule = () => {
				if (scheduled) return;
				scheduled = true;
				// 用 requestAnimationFrame 合并同一轮的多次变更，避免抖动
				const raf =
					typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn) => setTimeout(fn, 0);
				raf(() => {
					scheduled = false;
					draw();
				});
			};

			// 1) 会话数据变化 → 重画
			const unwatch = sessionService(ctx)?.list?.subscribe?.(schedule);
			// 2) DOM 变化（宿主重渲染 / 切换工作区 / 展开工作区）→ 重画
			observer.observe(target, { childList: true, subtree: true });
			// 3) Phase 3：工单快照变化 → 重画（轮询在独立闭包里，不占任何 ctx 服务）
			let stopPolling = () => {};
			try {
				stopPolling = startTicketPolling(() => schedule());
			} catch {
				/* 浏览器环境没有 fetch 时静默：侧栏树照常，只是不显示状态条 */
			}

			// 首次同步画一遍：不能只靠 schedule()，因为在后台标签页或首帧里
			// requestAnimationFrame 可能被浏览器节流，用户会以为插件没生效。
			draw();

			return () => {
				try {
					unwatch?.();
				} catch {
					/* 已经卸载 */
				}
				try { stopPolling(); } catch { /* 已经停止 */ }
				observer.disconnect();
				for (const node of doc.querySelectorAll(`[${TREE_ATTR}]`)) node.remove();
				for (const node of doc.querySelectorAll(`[${ATTR}-toggle]`)) node.remove();
				for (const node of doc.querySelectorAll(`[${ATTR}-ctrl]`)) node.remove();
				for (const node of doc.querySelectorAll(`[${ATTR}-bar]`)) node.remove();
				for (const node of doc.querySelectorAll(`[${ATTR}-queue]`)) node.remove();
				doc.getElementById(STYLE_ID)?.remove();
			};
		}

		/**
		 * 插件入口。
		 *
		 * ⚠️ `sessions` 必须写进 inject：cordis 会校验 `ctx.get('sessions')` 与
		 * `ctx.sessions`，不在 inject 名单里就抛
		 * `cannot get property "sessions" without inject` —— 而那个异常发生在渲染
		 * 路径上，会被本文件的 try/catch 吞成「树一直是空的」，非常难查。
		 *
		 * `uiWorkspace` 写进 inject：宿主提供的官方「打开某个会话」入口，点击子行时
		 * 优先用它（`openSession(sessionId)`）。`sidebarRight` 故意**不**写进 inject ——
		 * 它在不同宿主版本里可能不存在，属于可选的「右侧标签页」增强，取不到时自动
		 * 降级到普通跳转。
		 */
		/* ────────────────────────────────────────────────────────────────────────
		 * 设置页：「Router 项目经理」
		 *
		 * ⚠️ 为什么是「延迟挂载的独立 fiber」而不是把新服务塞进本 fiber 的 inject：
		 *   侧栏树（本 fiber）只用 sessions / locale / slots / uiWorkspace。设置页
		 *   还需要 configForms（与可选的 remote/remote.session）。若把这些塞进本
		 *   fiber 的 inject，任一服务没就绪，cordis 就会让**整个** client fiber 停在
		 *   PENDING（"waiting for service: X"），连侧栏树一起不加载 —— 用户 m04784
		 *   明确要求「保留子智能体显示的插件」。ctx.inject(deps, cb) 另开一个子 fiber
		 *   单独等它的依赖：设置页等不到就只是设置页不出，侧栏树照常。
		 *
		 * ctx.get(name) 是「不带 inject 要求」的宽松读取（reflect.ts 原文：
		 * "Read a service from the store without the inject requirement"），所以模型
		 * 目录这类**可选**增强用它取，取不到就降级，绝不进 inject 名单。
		 * ──────────────────────────────────────────────────────────────────────── */
		const SETTINGS_NS = "settings.subagent-tree";
		/** = cordis.patch.yml 里的 insert id，也是 configForms 的命名空间。 */
		const OWN_MODELS_NS = "subagent-tree";
		/** 宿主 dsh-subagent 那一行的命名空间（并发 / 深度上限住在这里）。 */
		const HOST_LIMITS_NS = "subagent";
		const SETTINGS_SECTION_ID = "subagent-tree";
		const SAT_WORKER_TYPES = ["subagent", "subagent_fork", "subagent_ptc", "subagent_minimal"];
		const SAT_CSS_TAG = "dsh-subagent-tree/settings.css";

		const settingsZh = {
			nav: "Router 项目经理",
			title: "Router 项目经理",
			intro: "子对话树、工单式派活与卡死收尾的配置。并发上限编辑的是宿主 subagent 那一个值，对所有模式生效。",
			limitsTitle: "运行限制",
			limitsNote: "改完即写，不需要保存。测试时若把它调成过 2，用完记得调回 8。",
			maxActive: "子代理并行数量上限",
			maxActiveHint: "同时最多几个子代理在跑（宿主 subagent.maxActiveSubagents）。Router 撞到上限会把新工单排队，不会判死。",
			maxDepth: "子代理嵌套深度上限",
			maxDepthHint: "子代理还能不能再派子代理（宿主 subagent.maxDepth）。Router 模式固定只派一层，通常保持 1。",
			modelsTitle: "子代理使用的模型",
			modelsNote: "四类 worker 可各自指定路线；留空＝继承协调者。改动后点保存。目录读不到时仍可清空已存的选择。",
			wt_subagent: "完整 worker（subagent）",
			wt_subagent_fork: "续作 worker（subagent_fork）",
			wt_subagent_ptc: "程序化 worker（subagent_ptc）",
			wt_subagent_minimal: "只读 worker（subagent_minimal）",
			inherit: "继承协调者",
			stale: "（目录里已不存在）",
			clearAll: "全部清空",
			discard: "放弃改动",
			save: "保存",
			saving: "保存中…",
			saveFailed: "保存失败：设置已在别处更新，请放弃改动后重试。",
			catalogFailed: "模型目录暂时读不到；已保存的选择仍显示在下拉里，可照常清空。",
			runtimeTitle: "运行时与验证",
			runtimeNote: "以下为只读信息。runtime: false 可整块关掉工单运行时，ticket_create 会自动退回直接派单。",
			runtimeDb: "工单表（sqlite，重启后恢复 running / queued 工单）",
			runtimeWatchdog: "Watchdog：running 静默 15 分钟判卡死并中断；queued 超 30 分钟只告警一次。",
			loading: "正在读取设置…",
			readOnly: "当前配置只读，无法修改。",
			unavailable: "设置表单不可用（configForms 未就绪）。",
		};
		const settingsEn = {
			nav: "Router PM",
			title: "Router PM",
			intro: "Settings for the sub-conversation tree, ticket-based delegation and the watchdog. The concurrency limit edits the host subagent value and applies to every mode.",
			limitsTitle: "Run limits",
			limitsNote: "Written immediately, no save button. If you lowered it to 2 for testing, set it back to 8 afterwards.",
			maxActive: "Max active subagents",
			maxActiveHint: "How many subagents may run at once (host subagent.maxActiveSubagents). Router queues new tickets at the cap instead of failing them.",
			maxDepth: "Max delegation depth",
			maxDepthHint: "Whether a subagent may spawn its own (host subagent.maxDepth). Router always delegates exactly one level, so 1 is typical.",
			modelsTitle: "Subagent models",
			modelsNote: "Each worker type can pick its own route; blank = inherit the coordinator. Press Save to commit. Clearing stored values works even if the catalog is unavailable.",
			wt_subagent: "Full worker (subagent)",
			wt_subagent_fork: "Continuation worker (subagent_fork)",
			wt_subagent_ptc: "Programmatic worker (subagent_ptc)",
			wt_subagent_minimal: "Read-only worker (subagent_minimal)",
			inherit: "Inherit coordinator",
			stale: " (no longer in catalog)",
			clearAll: "Clear all",
			discard: "Discard",
			save: "Save",
			saving: "Saving…",
			saveFailed: "Save failed: settings changed elsewhere. Discard and retry.",
			catalogFailed: "Model catalog is temporarily unavailable; stored choices still show and can be cleared.",
			runtimeTitle: "Runtime & verification",
			runtimeNote: "Read-only. runtime: false disables the whole ticket runtime; ticket_create falls back to direct dispatch.",
			runtimeDb: "Ticket DB (sqlite; running / queued tickets recover after restart)",
			runtimeWatchdog: "Watchdog: a running ticket silent for 15 min is interrupted and failed; a queued ticket over 30 min warns once.",
			loading: "Loading settings…",
			readOnly: "This configuration is read-only.",
			unavailable: "Settings form unavailable (configForms not ready).",
		};

		/** 唯一前缀 sat-，避免与同时装着的 dsh-multitask 的 mt-* 撞样式。 */
		const SAT_CSS = [
			"/* dsh-subagent-tree settings page */",
			".sat-root{display:flex;flex-direction:column;gap:24px;max-width:720px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif);font-size:14px;line-height:22px}",
			".sat-head{display:flex;flex-direction:column;gap:6px}",
			".sat-title{margin:0;font-size:20px;font-weight:600;line-height:28px}",
			".sat-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}",
			".sat-card{background:var(--dsw-alias-bg-layer-1,#f6f7f9);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg,16px)}",
			".sat-cardHead{padding:14px 16px 0}",
			".sat-cardTitle{font-size:14px;font-weight:600;line-height:22px}",
			".sat-cardNote{margin:0;padding:6px 16px 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".sat-rows{display:flex;flex-direction:column;border-top:.5px solid var(--dsw-alias-border-l2)}",
			".sat-row{display:flex;align-items:center;gap:16px;padding:14px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
			".sat-row:last-child{border-bottom:none}",
			".sat-rowText{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}",
			".sat-rowLabel{font-size:14px;line-height:22px}",
			".sat-rowDesc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".sat-rowControl{flex:none;display:flex;align-items:center;gap:8px}",
			".sat-num{font:inherit;font-size:13px;height:34px;width:84px;padding:0 10px;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,12px)}",
			".sat-num[data-bad=true]{border-color:var(--dsw-alias-state-error-primary,#cf222e)}",
			".sat-num:disabled{opacity:.5}",
			".sat-select{appearance:none;font:inherit;font-size:13px;height:34px;min-width:232px;max-width:300px;padding:0 12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,#fff);border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md,12px);cursor:pointer;text-overflow:ellipsis}",
			".sat-select:disabled{opacity:.5;cursor:default}",
			".sat-select option{background-color:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary)}",
			".sat-actions{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}",
			".sat-btn{appearance:none;font:inherit;font-size:13px;line-height:20px;padding:6px 14px;border-radius:var(--dsw-radius-md,12px);border:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary);cursor:pointer}",
			".sat-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
			".sat-btn:disabled{opacity:.45;cursor:default}",
			".sat-btn[data-primary=true]{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary-foreground,#fff)}",
			".sat-err{font-size:12px;color:var(--dsw-alias-state-error-primary,#cf222e)}",
			".sat-banner{margin:0;padding:10px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);border-top:.5px solid var(--dsw-alias-border-l2)}",
			".sat-kv{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".sat-kv:last-child{border-bottom:none}",
			".sat-kv code{font-family:var(--ds-font-family-code,ui-monospace,Menlo,monospace);font-size:11.5px;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover);border-radius:6px;padding:1px 6px;white-space:nowrap}",
			".sat-note{margin:0;padding:10px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warning-primary,#9a6700);border-top:.5px solid var(--dsw-alias-border-l2)}",
			"@media (max-width:560px){.sat-row{flex-wrap:wrap;gap:10px}.sat-select{min-width:0;width:100%}}",
		].join("");

		function injectSatCss() {
			try {
				if (typeof document === "undefined") return;
				if (document.querySelector("style[data-plugin-css=" + JSON.stringify(SAT_CSS_TAG) + "]")) return;
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-subagent-tree";
				tag.dataset.pluginCss = SAT_CSS_TAG;
				tag.textContent = SAT_CSS;
				document.head.appendChild(tag);
			} catch { /* 样式注入失败不影响功能 */ }
		}

		function satCreateStore(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => value,
				subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
				set: (next) => { value = next; for (const fn of Array.from(listeners)) fn(); },
			};
		}
		function satUseStore(store) {
			return react.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
		}

		function satSameMap(a, b) {
			if (a.size !== b.size) return false;
			for (const [k, v] of a) {
				const w = b.get(k);
				if (!w || w.provider !== v.provider || w.model !== v.model) return false;
			}
			return true;
		}

		/** 宿主 subagent 命名空间：maxDepth / maxActiveSubagents，改完即写。 */
		class SatLimits {
			constructor(form) {
				this.form = form;
				this.store = satCreateStore(this.projection());
				this.unsubscribe = typeof form?.subscribe === "function"
					? form.subscribe(() => this.store.set(this.projection())) : () => {};
			}
			snap() {
				const s = this.form?.getSnapshot?.() ?? {};
				const v = s.value ?? {};
				const num = (x, d) => (typeof x === "number" && Number.isFinite(x)) ? x : (Number.parseInt(x, 10) || d);
				return {
					status: s.status ?? "unavailable",
					writable: s.writable === true,
					revision: s.revision,
					maxDepth: num(v.maxDepth, 1),
					maxActive: num(v.maxActiveSubagents, 8),
				};
			}
			projection() { return this.snap(); }
			async commit(field, value) {
				const s = this.snap();
				if (s.status !== "ready" || !s.writable) return false;
				const path = field === "maxDepth" ? ["maxDepth"] : ["maxActiveSubagents"];
				try { return (await this.form.mutate([{ op: "set", path, value }], s.revision)) === true; }
				catch { return false; }
			}
			dispose() { try { this.unsubscribe(); } catch { /* noop */ } }
		}

		/** 本包命名空间：volatile 字段 subagentModels（四类 worker 的模型路线）。 */
		class SatModels {
			constructor(form, c, t) {
				this.form = form;
				this.ctx = c;
				this.t = t;
				this.catalog = [];
				this.catalogStatus = "idle";
				this.draft = undefined;
				this.draftRevision = undefined;
				this.saving = false;
				this.failed = false;
				this.disposed = false;
				this.store = satCreateStore(this.projection());
				this.unsubscribe = typeof form?.subscribe === "function"
					? form.subscribe(() => { if (!this.disposed) this.publish(); }) : () => {};
			}
			snap() {
				const s = this.form?.getSnapshot?.() ?? {};
				const list = Array.isArray(s.value?.subagentModels) ? s.value.subagentModels : [];
				return { status: s.status ?? "unavailable", writable: s.writable === true, revision: s.revision, list };
			}
			storedMap() {
				const m = new Map();
				for (const e of this.snap().list) {
					if (!e || typeof e !== "object" || !SAT_WORKER_TYPES.includes(e.subagentType)) continue;
					if (typeof e.provider !== "string" || typeof e.model !== "string" || !e.provider || !e.model) continue;
					m.set(e.subagentType, { provider: e.provider, model: e.model });
				}
				return m;
			}
			desired() { return this.draft === undefined ? this.storedMap() : this.draft; }
			beginDraft() {
				if (this.draft === undefined) { this.draft = this.storedMap(); this.draftRevision = this.snap().revision; }
				return this.draft;
			}
			setType(type, value) {
				const s = this.snap();
				if (this.disposed || s.status !== "ready" || !s.writable || this.saving) return;
				const m = this.beginDraft();
				if (!value) m.delete(type);
				else { const o = this.catalog.find((x) => x.key === value); if (o) m.set(type, { provider: o.provider, model: o.model }); }
				this.failed = false;
				this.publish();
			}
			clearAll() {
				const s = this.snap();
				if (this.disposed || s.status !== "ready" || !s.writable || this.saving) return;
				this.beginDraft().clear();
				this.failed = false;
				this.publish();
			}
			discard() { if (this.saving) return; this.draft = undefined; this.draftRevision = undefined; this.failed = false; this.publish(); }
			async loadCatalog() {
				if (this.disposed || this.catalogStatus === "loading") return;
				this.catalogStatus = "loading"; this.publish();
				try {
					// 目录是可选增强：宽松 get，不进 inject 名单。
					const remote = this.ctx.get?.("remote");
					const session = remote?.session ?? this.ctx.get?.("remote.session");
					const fn = session?.modelCatalog ?? remote?.modelCatalog;
					const response = typeof fn === "function" ? await fn.call(session ?? remote) : undefined;
					if (this.disposed) return;
					const groups = response?.ok ? (response.value?.groups ?? []) : [];
					this.catalog = [];
					for (const g of groups) for (const m of (g.models || [])) {
						this.catalog.push({ key: String(g.id) + "\u0000" + String(m.id), provider: g.id, model: m.id,
							label: (g.name || g.id) + " / " + (m.name || m.id) });
					}
					this.catalogStatus = response && response.ok ? "ready" : "error";
				} catch { if (!this.disposed) this.catalogStatus = "error"; }
				this.publish();
			}
			async save() {
				const s = this.snap();
				if (this.disposed || s.status !== "ready" || !s.writable || this.saving || this.draft === undefined) return;
				if (s.revision !== this.draftRevision) { this.failed = true; this.publish(); return; }
				const value = SAT_WORKER_TYPES.filter((t) => this.draft.has(t))
					.map((t) => ({ subagentType: t, ...this.draft.get(t) }));
				this.saving = true; this.failed = false; this.publish();
				let ok = false;
				try { ok = (await this.form.mutate([{ op: "set", path: ["subagentModels"], value }], this.draftRevision)) === true; }
				catch { ok = false; }
				if (this.disposed) return;
				this.saving = false; this.failed = !ok;
				if (ok) { this.draft = undefined; this.draftRevision = undefined; }
				this.publish();
			}
			optionsFor(type) {
				const cur = this.desired().get(type);
				const entries = [];
				const curKey = cur ? cur.provider + "\u0000" + cur.model : "";
				if (cur && !this.catalog.some((o) => o.key === curKey)) {
					entries.push({ key: curKey, value: curKey, label: cur.provider + " / " + cur.model, stale: true });
				}
				for (const o of this.catalog) entries.push({ key: o.key, value: o.key, label: o.label, stale: false });
				return { value: cur ? curKey : "", entries };
			}
			projection() {
				const s = this.snap();
				const dirty = this.draft !== undefined && !satSameMap(this.storedMap(), this.draft);
				return {
					status: s.status, writable: s.writable,
					catalogStatus: this.catalogStatus,
					rows: SAT_WORKER_TYPES.map((type) => ({ type, label: this.t("wt_" + type), ...this.optionsFor(type) })),
					dirty, saving: this.saving, failed: this.failed,
				};
			}
			publish() { if (!this.disposed) this.store.set(this.projection()); }
			dispose() { this.disposed = true; try { this.unsubscribe(); } catch { /* noop */ } }
		}

		function SatNumberRow(props) {
			const [draft, setDraft] = react.useState(String(props.value));
			const [bad, setBad] = react.useState(false);
			react.useEffect(() => { setDraft(String(props.value)); setBad(false); }, [props.value]);
			const commit = async () => {
				const n = Number.parseInt(draft, 10);
				if (!Number.isFinite(n) || n < props.min) { setBad(true); return; }
				setBad(false);
				const ok = await props.commit(n);
				if (!ok) setBad(true);
			};
			const el = react.createElement;
			return el("div", { className: "sat-row" },
				el("div", { className: "sat-rowText" },
					el("span", { className: "sat-rowLabel" }, props.label),
					el("span", { className: "sat-rowDesc" }, props.desc)),
				el("div", { className: "sat-rowControl" },
					el("input", { className: "sat-num", type: "number", value: draft, min: props.min,
						"data-bad": bad ? "true" : "false",
						disabled: props.status !== "ready" || !props.writable,
						onChange: (e) => setDraft(e.target.value),
						onBlur: commit,
						onKeyDown: (e) => { if (e.key === "Enter") e.currentTarget.blur(); } })));
		}

		function SatSelectRow(props) {
			const el = react.createElement;
			const opts = [el("option", { value: "", key: "__inherit__" }, props.inherit)];
			for (const e of props.entries) {
				opts.push(el("option", { value: e.value, key: e.key }, e.label + (e.stale ? props.stale : "")));
			}
			return el("div", { className: "sat-row" },
				el("div", { className: "sat-rowText" }, el("span", { className: "sat-rowLabel" }, props.label)),
				el("div", { className: "sat-rowControl" },
					el("select", { className: "sat-select", value: props.value, disabled: props.disabled,
						onChange: (ev) => props.onChange(ev.target.value) }, opts)));
		}

		function satCard(el, title, note, rows, extra) {
			return el("div", { className: "sat-card" },
				el("div", { className: "sat-cardHead" }, el("span", { className: "sat-cardTitle" }, title)),
				note ? el("p", { className: "sat-cardNote" }, note) : null,
				el("div", { className: "sat-rows" }, rows),
				extra || null);
		}

		function SatSettingsPage(props) {
			const t = props.t;
			const limits = satUseStore(props.limits.store);
			const models = satUseStore(props.models.store);
			const el = react.createElement;
			const children = [];

			children.push(el("div", { className: "sat-head", key: "head" },
				el("h2", { className: "sat-title", key: "t" }, t("title")),
				el("p", { className: "sat-intro", key: "i" }, t("intro"))));

			if (limits.status !== "ready") {
				children.push(el("p", { className: "sat-banner", key: "lim-banner" },
					limits.status === "loading" ? t("loading") : t("unavailable")));
			} else if (!limits.writable) {
				children.push(el("p", { className: "sat-banner", key: "lim-ro" }, t("readOnly")));
			}

			const limitRows = [
				{ key: "maxActive", label: t("maxActive"), desc: t("maxActiveHint"), field: "maxActive", value: limits.maxActive, min: 1 },
				{ key: "maxDepth", label: t("maxDepth"), desc: t("maxDepthHint"), field: "maxDepth", value: limits.maxDepth, min: 0 },
			];
			children.push(satCard(el, t("limitsTitle"), t("limitsNote"), limitRows.map((r) =>
				el(SatNumberRow, { key: r.key, label: r.label, desc: r.desc, field: r.field, value: r.value,
					min: r.min, status: limits.status, writable: limits.writable,
					commit: (v) => props.limits.commit(r.field, v) }))));

			const modelRows = models.rows.map((r) =>
				el(SatSelectRow, { key: r.type, label: r.label, value: r.value, entries: r.entries,
					inherit: t("inherit"), stale: t("stale"),
					disabled: models.status !== "ready" || !models.writable || models.saving,
					onChange: (v) => props.models.setType(r.type, v) }));
			const actions = el("div", { className: "sat-actions", key: "actions" },
				el("button", { className: "sat-btn", type: "button", disabled: models.status !== "ready" || !models.writable || models.saving,
					onClick: () => props.models.clearAll() }, t("clearAll")),
				el("button", { className: "sat-btn", type: "button", disabled: !models.dirty || models.saving,
					onClick: () => props.models.discard() }, t("discard")),
				el("button", { className: "sat-btn", type: "button", "data-primary": "true",
					disabled: !models.dirty || models.saving || !models.writable,
					onClick: () => props.models.save() }, models.saving ? t("saving") : t("save")),
				models.failed ? el("span", { className: "sat-err", key: "err" }, t("saveFailed")) : null);
			const modelExtra = models.catalogStatus === "error"
				? el("p", { className: "sat-note", key: "cat" }, t("catalogFailed")) : null;
			children.push(satCard(el, t("modelsTitle"), t("modelsNote"), [...modelRows, actions], modelExtra));

			children.push(satCard(el, t("runtimeTitle"), t("runtimeNote"), [
				el("div", { className: "sat-kv", key: "db" },
					el("code", { key: "k" }, "~/.dsh/state/router-worker/tickets.db"),
					el("span", { key: "v" }, t("runtimeDb"))),
				el("div", { className: "sat-kv", key: "wd" },
					el("code", { key: "k" }, "15 / 30 min"),
					el("span", { key: "v" }, t("runtimeWatchdog"))),
			]));

			return el("div", { className: "sat-root" }, children);
		}

		function satForm(c, ns) {
			try { return c.configForms.get(ns); } catch { return undefined; }
		}

		function registerSatPage(c) {
			let bind = null;
			try { bind = c.locale.bind(SETTINGS_NS); } catch { bind = null; }
			const t = (key, params) => {
				let v;
				try { v = bind?.(key, params); } catch { v = undefined; }
				if (typeof v !== "string" || !v || v === key) v = settingsZh[key] ?? key;
				if (params && typeof v === "string") {
					v = v.replace(/\{(\w+)\}/g, (m, n) => params[n] === undefined ? m : String(params[n]));
				}
				return v;
			};
			c.effect(() => c.locale.register(SETTINGS_NS, { zh: settingsZh, en: settingsEn }),
				"dsh-subagent-tree: settings dictionaries");
			injectSatCss();
			const limits = new SatLimits(satForm(c, HOST_LIMITS_NS));
			const models = new SatModels(satForm(c, OWN_MODELS_NS), c, t);
			c.effect(() => () => { limits.dispose(); models.dispose(); },
				"dsh-subagent-tree: settings subscriptions");
			models.loadCatalog();
			const face = () => ({ t, limits, models });
			c.slots.inject("settings.section", () => c.slots.register({
				name: "settings.section",
				id: SETTINGS_SECTION_ID,
				order: 20,
				label: () => t("nav"),
				locale: SETTINGS_NS,
				inject: face,
			}, SatSettingsPage));
		}

		function mountSettings(ctx) {
			if (!react) return; // react 取不到就整页不挂，绝不影响侧栏树
			try {
				ctx.inject(["slots", "locale", "configForms"], (childCtx) => {
					try { registerSatPage(childCtx); }
					catch (error) { console.warn("dsh-subagent-tree: settings page failed", error); }
				});
			} catch (error) {
				console.warn("dsh-subagent-tree: settings fiber could not be registered", error);
			}
		}

		const inject = ["sessions", "locale", "slots", "uiWorkspace"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-subagent-tree: dictionaries");
			ctx.effect(() => {
				let translate = null;
				try {
					translate = ctx.locale.bind(NS);
				} catch {
					translate = null;
				}
				const t = (key, params) => {
					let value;
					try {
						value = translate?.(key, params);
					} catch {
						value = undefined;
					}
					// 宿主 locale 找不到 key 时可能把 key 原样返回 —— 那也算没翻译，
					// 要退回自带字典，否则界面上会出现 "tree.less" 这种原文。
					if (typeof value !== "string" || !value || value === key) value = zh[key] ?? key;
					if (params && typeof value === "string") {
						value = value.replace(/\{(\w+)\}/g, (match, name) =>
							params[name] === undefined ? match : String(params[name]),
						);
					}
					return value;
				};
				try {
					return install(ctx, t);
				} catch (error) {
					// 侧栏树挂不上就当没装，绝不把异常抛回 cordis：抛出去会让整个
					// client entry 停在 loading/failed，宿主启动直接失败。
					console.error("dsh-subagent-tree: install failed", error);
					return;
				}
			}, "dsh-subagent-tree: sidebar tree");
			// 设置页走一个独立的延迟 fiber：它等的服务缺席时只影响设置页，
			// 不会把上面这棵侧栏树一起拖到 PENDING。
			try { mountSettings(ctx); } catch (error) {
				console.warn("dsh-subagent-tree: settings mount skipped", error);
			}
		}

		exports.NS = NS;
		exports.STORAGE_KEY = STORAGE_KEY;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
