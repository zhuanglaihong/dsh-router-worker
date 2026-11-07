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
		};

		/** 一次注入的样式表（主题变量优先，缺了也还有退路）。 */
		const CSS = `
[${ATTR}-of] { display: contents; }
[${ATTR}-row] {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 缩进刻意做到「明显低一档」：宿主的会话标题大约从 30px 起（8px 内边距 +
     16px 图标 + 6px 间隙），我们的展开箭头又把它推到 ~50px。所以子行的引导线
     放在 48px（正好落在主行文字起点），文字再推到 64px 之后 —— 一行就能看出
     谁是父、谁是子，不会出现「子行和主行同对齐」的错觉。 */
  padding: 3px 8px 3px 64px;
  margin-left: 0;
  min-height: 22px;
  font-size: var(--dsw-font-size-sm, 12px);
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary, currentColor);
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  opacity: .92;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[${ATTR}-row]:hover {
  background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12));
  color: var(--dsw-alias-label-primary, inherit);
}
[${ATTR}-row][data-running="true"] { color: var(--dsw-alias-label-primary, inherit); }
/* 连接线：一条竖线 + 一条横向短枝，全部用 currentColor 淡化，所以跟主题走。
   竖线故意落在主行标题文字之外（48px），这样「缩进」是从引导线本身开始的。 */
[${ATTR}-row]::before {
  content: "";
  position: absolute;
  left: 48px;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
}
[${ATTR}-row]::after {
  content: "";
  position: absolute;
  left: 48px;
  top: 50%;
  width: 12px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35));
}
[${ATTR}-row][data-last="true"]::before { bottom: 50%; }
[${ATTR}-dot] {
  flex: 0 0 auto;
  width: 5px; height: 5px; border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary, rgba(127,127,127,.6));
}
[${ATTR}-row][data-running="true"] [${ATTR}-dot] {
  background: var(--dsw-alias-brand-primary, #4c8dff);
}
[${ATTR}-label] {
  flex: 1 1 auto;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
[${ATTR}-status] {
  flex: 0 0 auto;
  font-size: var(--dsw-font-size-xs, 11px);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor));
  opacity: .8;
}
/* 「还有 N 条更早的子对话」——子对话太多时只显示最近几条，其余折起来。 */
[${ATTR}-more] {
  display: flex; align-items: center;
  padding: 2px 8px 2px 64px;
  font-size: var(--dsw-font-size-xs, 11px);
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, currentColor));
  cursor: pointer; user-select: none; opacity: .8;
}
[${ATTR}-more]:hover { opacity: 1; color: var(--dsw-alias-label-primary, inherit); }
/* 展开态：这一行变成「收起」入口，稍微淡一点，表示它是可回退的操作。 */
[${ATTR}-more][data-expanded="1"] { opacity: .55; }
[${ATTR}-more][data-expanded="1"]:hover { opacity: 1; }

/* 主行上的「收起 / 展开」小箭头：**浮在行首那段留白里、不占布局**。
   用户反馈（m02555）：「主对话和箭头空出来一段了」—— 之前把 16px 的按钮插进
   行内容流，宿主那一格本来是空的（没有图标），于是箭头右侧空出一格。
   用户反馈（m04165）：「对话运行的时候，左侧转圈和下拉按钮重叠了」—— 改成绝对
   定位 left:2px 之后又撞上了宿主的运行状态指示器（会话行 span.slot 里在
   state !== "idle" 时渲染的就是那个转圈）。
   所以 left 不再写死：placeToggle() 量出行首内边距，把箭头摆在「留白内、内容
   左侧」，必要时才把内容整体右移一个箭头的宽度。宿主自己的 actions 区在行尾
   且要 hover 才显形，那里放箭头等于藏起来。 */
[${ATTR}-host] { position: relative; }
[${ATTR}-toggle] {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px;
  position: absolute; left: 0; top: 50%; transform: translateY(-50%);
  border: 0; padding: 0; margin: 0;
  background: transparent; color: inherit; cursor: pointer; opacity: .75;
  border-radius: 4px; z-index: 2;
}
[${ATTR}-toggle]:hover { opacity: 1; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.14)); }
[${ATTR}-toggle] > svg { transition: transform .12s ease; }
[${ATTR}-toggle][data-collapsed="true"] > svg { transform: rotate(-90deg); }
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
		 * 主行右端的收起/展开箭头。
		 *
		 * 塞进宿主行内部（`[data-row-key]` 自身），因为列表行是宿主画的，我们只能在
		 * 它的 DOM 里加一个不抢布局的子元素。用 `pointer-events` + `stopPropagation`
		 * 保证点箭头不会顺带切会话。
		 */
		function buildToggle(t, parentId, collapsed, hasChildren) {
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

		/** 箭头按钮的边长 + 与行首内容之间至少要留出的间距。 */
		const TOGGLE_SIZE = 16;
		const TOGGLE_GAP = 4;

		/**
		 * 把箭头放到主行**行首那块留白里**，既不压到任何东西，也不占布局。
		 *
		 * 三次踩坑的记录：
		 *  1. 最早把 16px 按钮当行内元素 insertBefore 进行内容流 —— 宿主会话行这一格
		 *     本来没有图标（文件夹图标只有工作区标题行才有），箭头右侧空出一格，
		 *     主行文字被推得比别的行更右（用户 m02555：「空出来一段」）。
		 *  2. 改成绝对定位 + 找最左文字节点往左挪 18px —— 又撞上了宿主的
		 *     **状态指示器**（会话运行中时 span.slot 里渲染的是转圈
		 *     SessionStatusDots，见宿主会话行：showStatus = primaryStatus.state !== "idle"），
		 *     于是运行中的行出现「转圈和箭头重叠」（用户 m04165）。
		 *  3. 按行首 padding 算 left —— 不够稳：滑动区可能更靠右（leading slot 有
		 *     自己的宽度或外边距），箭头还是会贴到内容上。
		 *
		 * 正解：**量行内第一个真实子元素的实际左边界**（空闲时是 leading slot，
		 * 运行时是转圈容器，无论哪个都能量到），把箭头摆进 [行左边界, 那个左边界)
		 * 这段空间里并居中；空间不够（TOGGLE_SIZE + TOGGLE_GAP）就补足行首内边距，
		 * 让内容整体右移刚好够用。这样箭头永远在内容左侧、且留有余量。
		 *
		 * 只对**有子对话的主行**生效，同一层级的兄弟行不会跟着错位。
		 * 原始 padding 存进 ATTR-pad 属性，避免每次重画重复累加；render 开始时会
		 * 把上一轮的改动整体还原（父行没有子对话了就不该继续右移）。
		 */
		function placeToggle(row, toggle) {
			if (row.querySelector(`[${ATTR}-toggle]`)) return;
			row.setAttribute(ATTR + "-host", "1");

			let base = 0;
			const stored = row.getAttribute(`${ATTR}-pad`);
			if (stored !== null) {
				base = Number.parseFloat(stored) || 0;
			} else {
				try {
					base = Number.parseFloat(getComputedStyle(row).paddingInlineStart) || 0;
				} catch {
					base = 0;
				}
				row.setAttribute(`${ATTR}-pad`, String(base));
			}

			// 行内第一个真实子元素（排除我们自己的箭头）：内容实际从哪里开始。
			//
			// 用 offsetLeft（**未变换的布局像素**）而不是 getBoundingClientRect 相减：
			// 侧栏在某些缩放/transform 场景下 rect 是变换后的屏幕坐标，直接拿来当
			// `left` 用会按缩放比例偏移，箭头又贴回内容上。
			// 行本身在我们加了 ATTR-host 之后是 position:relative，所以子元素的
			// offsetParent 就是行，offsetLeft 天然以行的 padding 边界为基准。
			let leadLeft = base;
			for (const child of row.children) {
				if (child === toggle || child.hasAttribute(`${ATTR}-toggle`)) continue;
				const box = child.getBoundingClientRect();
				if (!box.width && !box.height) continue;
				const offset = child.offsetLeft;
				leadLeft = Number.isFinite(offset) && offset > 0 ? offset : base;
				break;
			}

			const need = TOGGLE_SIZE + TOGGLE_GAP;
			if (leadLeft < need) {
				const shift = need - leadLeft;
				row.style.paddingInlineStart = `${base + shift}px`;
				row.setAttribute(`${ATTR}-padset`, "1");
				leadLeft = need;
			}

			// 在 [0, leadLeft) 这段空间里居中，看起来才不像「挤在内容边上」；
			// 但**先保间距**：居中位置如果让箭头右边缘离内容不足 TOGGLE_GAP，
			// 就往左推到刚好留住间距为止（极端窄主题下会推到 0）。
			const centered = Math.round((leadLeft - TOGGLE_SIZE) / 2);
			const keepGap = leadLeft - TOGGLE_SIZE - TOGGLE_GAP;
			const left = Math.max(0, Math.min(centered, keepGap));
			toggle.style.left = `${left}px`;
			row.appendChild(toggle);
		}

		/** 还原主行上一轮被 placeToggle 改过的行首内边距（父行没子对话了就不该继续右移）。 */
		function clearToggleHost(row) {
			const stored = row.getAttribute(`${ATTR}-pad`);
			// 只有**我们自己**顶开过内边距时才需要写回去；否则把 style 上那条清掉，
			// 让宿主自己的样式表说了算（避免和宿主的 inline style 打架）。
			if (stored !== null && row.getAttribute(`${ATTR}-padset`) === "1") {
				row.style.paddingInlineStart = `${Number.parseFloat(stored) || 0}px`;
			} else if (row.style.paddingInlineStart) {
				row.style.removeProperty("padding-inline-start");
			}
			row.removeAttribute(`${ATTR}-pad`);
			row.removeAttribute(`${ATTR}-padset`);
			row.removeAttribute(`${ATTR}-host`);
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

		function render(ctx, t) {
			const doc = document;
			const list = sessionService(ctx)?.list;
			const snapshot = list?.getSnapshot?.();
			const byId = snapshot?.byId ?? {};

			// 1) 清掉上一轮产物（子树容器 + 主行里的箭头 + 「更早的子对话」提示）
			for (const node of doc.querySelectorAll(`[${TREE_ATTR}]`)) node.remove();
			for (const node of doc.querySelectorAll(`[${ATTR}-toggle]`)) node.remove();
			for (const node of doc.querySelectorAll(`[${ATTR}-more]`)) node.remove();
			for (const node of doc.querySelectorAll(`[${ATTR}-all]`)) node.remove();
			// 同时把上一轮给主行加的行首内边距整体还原 —— 这一轮没有子对话的主行
			// 不该继续被推右（否则删完子会话，主行还留着一段空白）。
			for (const row of doc.querySelectorAll(`[${ATTR}-pad]`)) clearToggleHost(row);

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
				if (children.length === 0) continue;

				const names = labelIndex(catalogOf(snapshot, parentId));
				const isCollapsed = collapsed.get(parentId) === true;

				// 3a) 主行行首加箭头（绝对定位，不占布局）
				const toggle = buildToggle(t, parentId, isCollapsed, true);
				toggle.addEventListener("click", (event) => {
					event.preventDefault();
					event.stopPropagation();
					const map = readCollapsed();
					if (map.get(parentId) === true) map.delete(parentId);
					else map.set(parentId, true);
					writeCollapsed(map);
					render(ctx, t);
				});
				placeToggle(row, toggle);

				// 3b) 收起状态就不画子行 —— 只留主对话在外边
				if (isCollapsed) continue;

				// 3c) 子对话太多时只画最近的几条（按时间正序，所以取尾部）
				//     用户反馈：每派一次活就多一条会话，列表会越堆越长。
				const showAll = expanded.get(parentId) === true;
				const folded = children.length > MAX_VISIBLE ? children.length - MAX_VISIBLE : 0;
				const hidden = showAll ? 0 : folded;
				const visible = hidden === 0 ? children : children.slice(hidden);

				// 3d) 在宿主行后面插一块子树容器
				const holder = doc.createElement("div");
				holder.setAttribute(TREE_ATTR, parentId);
				holder.setAttribute(ATTR + "-of", "1");
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
				// 插在**宿主行自己的后面**（不是 parentElement 后面 —— 那个可能是整个
				// 滚动容器，插进去树就跑到列表外面了）。holder 用 display:contents，
				// 所以它的子行在布局上等于列表的直属子项，跟着列表一起滚。
				row.insertAdjacentElement("afterend", holder);
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
					if (kids.length === 0) continue;
					// 短名也要进指纹：主智能体后补/改了 label 时行文字要跟着变。
					const names = labelIndex(catalogOf(snapshot, parentId));
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
								.join(","),
					);
				}
				return parts.join(";");
			};

			let drawnSignature = null;

			const draw = () => {
				let signature = "";
				try {
					signature = signatureOf();
				} catch {
					signature = "";
				}
				// 指纹没变、而且上一轮的节点都还活着 → 什么都不做
				if (signature && signature === drawnSignature) {
					const alive =
						target.querySelectorAll(`[${TREE_ATTR}]`).length > 0 ||
						signatureOf() === "";
					if (alive) return;
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

			// 首次同步画一遍：不能只靠 schedule()，因为在后台标签页或首帧里
			// requestAnimationFrame 可能被浏览器节流，用户会以为插件没生效。
			draw();

			return () => {
				try {
					unwatch?.();
				} catch {
					/* 已经卸载 */
				}
				observer.disconnect();
				for (const node of doc.querySelectorAll(`[${TREE_ATTR}]`)) node.remove();
				for (const node of doc.querySelectorAll(`[${ATTR}-toggle]`)) node.remove();
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
		}

		exports.NS = NS;
		exports.STORAGE_KEY = STORAGE_KEY;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
