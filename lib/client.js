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
		 * 把标题**单独**往右推 delta 像素。
		 *
		 * 运行中的行里，宿主的 DOM 是「槽位(转圈) → 标题」，两者之间只有几个像素，
		 * 塞不下箭头。而加行内边距会把两者一起右移、间距不变（实测三次迭代都撞在
		 * 这上面）。所以只能动标题自己：给它加 margin-inline-start，flex 布局下
		 * 标题是弹性的，右推多少就自动缩窄多少，整行不会溢出。
		 *
		 * 累计值记在 ATTR-push 属性上，render 开始时一次性还原，避免每帧叠加。
		 */
		function pushTitle(title, delta) {
			if (!delta || delta <= 0) return;
			const key = `${ATTR}-push`;
			const prev = Number.parseFloat(title.getAttribute(key) ?? "0") || 0;
			const next = prev + delta;
			title.setAttribute(key, String(next));
			title.style.marginInlineStart = `${next}px`;
		}

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
		 *  3. 按行首 padding 算 left —— 不够稳：槽位可能更靠右（leading slot 有
		 *     自己的宽度或外边距），箭头还是会贴到内容上。
		 *
		 *  4. 贴左 + 跳过空壳槽位 —— 箭头落在了行首留白的最左边，静态时与标题之间
		 *     仍隔着一大段（用户 m04718 的截图）。
		 *
		 * 正解：**按标题的实际左边界定位**。箭头摆在标题左侧只留 TOGGLE_GAP；
		 * 若行首已有占位物（运行中的转圈），则排在它右边（转圈→箭头→标题），
		 * 空间不足时右推整行内容。这样静态紧贴、动态不重叠、且顺序符合直觉。
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

			// 量两个位置：标题文字的左边界，以及行首槽位里「占位物」的右边界。
			//
			// 用 offsetLeft / offsetWidth（**未变换的布局像素**）而不是 rect 相减：
			// 侧栏在缩放下 rect 是变换后的屏幕坐标，直接拿来当 left 用会按比例偏移，
			// 箭头又贴回内容上。行本身在加了 ATTR-host 之后是 position:relative，
			// 所以子元素的 offsetParent 就是行，offsetLeft 天然以行的 padding 边界为基准。
			//
			// 用户 m04718 要的最终形态：
			//   静态：                       [箭头][间隙][标题]      ← 箭头往右紧贴标题
			//   运行中：[转圈][间隙][箭头][间隙][标题]            ← 转圈在箭头左边
			//
			// 所以箭头位置 = 标题左边界 - 箭头 - 间隙；如果行首已经有占位物（转圈），
			// 再取「占位物右边界 + 间隙」和它当中更靠右的那个，必要时把整行内容右推。
			function measure(row, toggle) {
				let contentLeft = NaN;
				let reservedRight = NaN;
				let title = null;
				for (const child of row.children) {
					if (child === toggle || child.hasAttribute(`${ATTR}-toggle`)) continue;
					const offset = child.offsetLeft;
					if (child.textContent.trim() === "") {
						// 没文字：空槽位（跳过）或转圈之类的占位物（记下右边界）。
						if (child.children.length > 0 && child.offsetWidth > 0.5) {
							reservedRight = Math.max(
								Number.isNaN(reservedRight) ? -Infinity : reservedRight,
								offset + child.offsetWidth,
							);
						}
						continue;
					}
					// 第一个有文字的元素就是标题：它的左边界就是内容起点。
					if (Number.isFinite(offset)) contentLeft = offset;
					title = child;
					break;
				}
				return { contentLeft, reservedRight, title };
			}

			const need = TOGGLE_SIZE + TOGGLE_GAP;
			const { contentLeft, reservedRight, title } = measure(row, toggle);
			const titleLeft = Number.isFinite(contentLeft) ? contentLeft : base + need;

			let left;
			if (Number.isFinite(reservedRight)) {
				// 运行中：转圈 → 箭头 → 标题。箭头排在转圈右边。
				left = reservedRight + TOGGLE_GAP;
				// 宿主给「转圈→标题」留的空隙通常只有几个像素，塞不下 16px 箭头。
				// 注意**不能靠加行内边距**来解决：那会把转圈和标题一起右移，
				// 两者之间的间距一点没变（实测三轮迭代都撞在这上面）。
				// 只能把标题单独往右推。
				const wanted = left + TOGGLE_SIZE + TOGGLE_GAP;
				if (title) pushTitle(title, Math.round(wanted - titleLeft));
			} else {
				// 空闲：箭头紧贴标题左侧。
				left = titleLeft - TOGGLE_SIZE - TOGGLE_GAP;
				if (left < 0) {
					// 窄主题：标题左边连箭头都放不下，才右推整行内容。
					row.style.paddingInlineStart = `${base + need - titleLeft}px`;
					row.setAttribute(`${ATTR}-padset`, "1");
					left = 0;
				}
			}
			toggle.style.left = `${Math.max(0, Math.round(left))}px`;
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
			// 还原被 pushTitle 右推过的标题（父行没子对话了就不该继续偏移）。
			for (const pushed of row.querySelectorAll(`[${ATTR}-push]`)) {
				pushed.style.removeProperty("margin-inline-start");
				pushed.removeAttribute(`${ATTR}-push`);
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
