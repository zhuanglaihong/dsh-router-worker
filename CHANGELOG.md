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

### 变更

- 包从「纯显示层」变为「显示层 + 调度层」，安装一次即可。
- `engines.node` 从 `>=20` 升到 `>=24`（后续要用的 `node:sqlite`）。

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
