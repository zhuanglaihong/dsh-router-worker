# Changelog

本包两个版本线：`0.1.x` 只有侧栏显示；`0.2.x` 起把 Router/Worker 调度合并进来。

## 0.2.0 — 进行中

合并单包：装一次，得到「Router 项目经理模式」+ 侧栏子对话树。

### 新增

- **Router 项目经理模式**（preset id `router-worker`）：从 `dsh-multitask` 1.3.3
  分叉，保留其协调者窄工具面、四类 worker、两级审批闸门、纠错立即生效、
  Windows 工作区 ACL 修复。
- 两类自建 worker 后端 `router_worker_ptc` / `router_worker_minimal` 由本包
  宿主半注册。

### Phase 1 — Router 语义

- **五份人格全部中文化**（协调者 + 四类 worker），并把「减震器」换成「项目经理」
  的说法：它现在说的是「你先想清楚再派」，而不是「你只负责挡住噪音」。
- **新增 `ticket_create` 工具**：派活从「调用一个委派工具」变成「开一张工单」。
  `title` 是必填参数（2–40 字），原样作为 `label` 传给 `startActivation`，因此
  侧栏子对话树显示的一定是短名，而不是提示词正文第一行。
  支持 `worker` 参数在 `subagent` / `subagent_minimal` / `subagent_ptc` /
  `subagent_fork` 之间选，provider 没装上时给出可改派的拒绝而不是抛错。
- **协调者人格新增一节「每张工单必须先起名」**：把短名规范从提示词里的软约束
  搬进参数表，并给出好/坏短名对照。
- `ticket_create` 已加进 `DEFAULT_KEEP` 与 composition 的 `keep` 数组 ——
  保留集是白名单，漏了的表现是「模式装上了但协调者看不到这个工具」，且不报错。

### 变更

- 包从「纯显示层」变为「显示层 + 调度层」，安装一次即可。
- `engines.node` 从 `>=20` 升到 `>=24`（后续要用的 `node:sqlite`）。
- 多模式总开关环境变量改名：`DSH_MULTITASK_MULTI_MODE` → `DSH_ROUTER_WORKER_MULTI_MODE`
  （旧的 `[multitask-mode:ptc]` / `[multitask-mode:minimal]` 旧会话标记保留不动）。

### 保留

- 侧栏子对话树的行为、配置、外观与 0.1.0 一致。

## 0.1.0 — 2026-11-07

首个可用版本：在左侧栏每个主对话下缩进显示子对话。

- 缩进树：竖线 + 横枝连接，子行标题从 64px 起
- 短名：优先读宿主 `subagentCatalog[].label`，回退 `displayTitle`，再回退 id 前 8 位
- 状态：`.running` / 结束，实时更新
- 折叠：每个主行独立 ▾/▸，状态存 localStorage
- 只显示最近 3 条，更早的收成「还有 N 条更早的子对话」
- 跨主题：只锚定 `data-row-key` 业务属性，颜色全用 `--dsw-alias-*` 语义变量
- 不依赖任何 agent 模式：只读宿主原生 `origin === 'subagent'` + `parentId`
