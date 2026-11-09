# 路线图与待办

本文件是**开发者的账本**：已完成的放在这里只为对照，未完成 / 待验证 / 已知缺口都记在这。
README 只写已可用、已验证的部分。

版本：`0.2.1`（npm 已发布；0.2.0 的 README 含真实项目名，已被 0.2.1 替换）。最后更新：2026-11-09。

---

## 一、已完成

| 版本 | 内容 | 验证 |
| --- | --- | --- |
| 0.1.0 | 侧栏子对话树（缩进、连接线、编号、短名、状态、折叠、localStorage 记忆） | 真宿主 CDP + 截图 |
| 0.2.0 Phase 0 | 从 `dsh-multitask` 1.3.3 分叉出 `router-worker` 模式（协调者窄工具面、四类 worker、两级审批闸门、Windows 工作区 ACL 修复） | 假 ctx 探针 + 沙盒启动 |
| 0.2.0 Phase 1 | 五份中文人格、`ticket_create`（title 必填 2–40 字，写进 `subagentCatalog.label`）、keep 白名单接线 | 探针 + 真机三张并行工单 |
| 0.2.0 Phase 2 | 工单落 sqlite（`tickets.db`）、dispatcher 排队、outbox 退避回流、重启恢复 | 单测 + 真机 |
| 0.2.0 Phase 3 | 侧栏树内联状态条（`N 运行中 / M 排队` + 排队项），宿主半 GET 路由 | CDP + 真机 |
| 0.2.0 Phase 4 | Watchdog（60s 巡检 / 15min 静默判死 / 30min 排队提醒，`session/event` 心跳） | 9 个单测 |
| 0.2.0 | 设置页「Router 项目经理」（运行限制 / 四类 worker 模型 / 运行时只读信息） | mock 探针 + 真宿主 CDP |
| 0.2.0 | 侧栏树**结构无关**渲染（兼容 `dsh-claude-style` 等自定义皮肤） | 单测 + CDP 逐像素几何 |
| 0.2.0 | 改名 `dsh-subagent-tree` → `dsh-router-worker`；npm 发布；GitHub Release 工作流 | 端到端装 npm 包启动 |
| 0.2.0 | 三平台 CI 矩阵（ubuntu / windows / macos × Node 24）+ 39 个单测 | GitHub Actions 首跑全绿 |
| 0.2.1 | 文档与隐私修正（README / CHANGELOG / 截图去真实项目名；未完成事项移入本文件） | 39 单测 + pack 校验 |

---

## 二、未完成 / 待验证

### 1. Windows / Linux 真机 GUI 与 ACL 冒烟（唯一的发布硬要求）

CI 只验证到代码层（语法 + 单测 + 打包）。Electron GUI 与 Win32 安全描述符无法在 CI
复现，本机开发环境也只有 macOS。**清单见 [PLATFORM.md](PLATFORM.md#真机冒烟清单给用户)。**

四项要逐条确认：

- [ ] 不出现 `SetNamedSecurityInfoW failed (Win32 5)`（Windows ACL / 安全描述符）
- [ ] pwsh / bash 工具按平台正确启用（`composition.mjs:1119/1124`）
- [ ] 子代理能在真机上写文件（工作区 ACL 前缀比较放行正确）
- [ ] 侧栏树短名 / 缩进 / 折叠在真机 GUI 下正常

任一平台四项全过，才把发布口径从「macOS 真机已验」升级。

### 2. 工单看板的完整面板（Phase 3 的重版）

0.2.0 做的是**轻量版**：侧栏树里内联一行状态条。完整版原计划走 `sidebar.panellist`
（replaceRisk `none`，安全座），点开是按状态分组的独立面板，每行带耗时、可「重试 / 取消」。

当时判断轻量版够用（排队项才是真缺口），**若真机上发现排队多了看不清，再做面板**。
详见 [plan-router-worker.md](plan-router-worker.md) 第十节。

### 3. 右键菜单「以子对话方式继续」

现状：会话右键菜单只有宿主原生的「分叉会话」。想做的是右键直接开一张子对话，并且
**可反复追问**（continuable 子代理）。

三方案与工作量已写在 [plan-subconversation-menu.md](plan-subconversation-menu.md)：
A 右键 + 输入框（约 1 天，推荐）／B continuable 子代理（1–2 天）／C 替换
`sidebar.workspaces`（不推荐，`replaceRisk: shadows-shipped-ui`）。

三个待定问题也记在那份文件里（子对话能否继续聊 / 用什么模式跑 / 结果怎么回主会话）。

---

## 三、已知缺口（不计划修复，属设计边界）

- **不是原生行**。宿主把左侧浏览区声明成 single 独占插槽，插件 slots 挂不进去，所以用
  DOM 注入。代价：子行没有置顶 / 重命名 / 归档 / 拖拽排序，点击是「打开」不是「选中」。
- **嵌套只画一层**。DSH 委派深度默认 1（worker 不能再派），一层够用；真出现孙会话时，
  它会在自己的父行下被单独渲染。
- **`Side: ` 开头的侧边对话不进来**，那是宿主自己的功能，语义上不是子代理。
- **`node:sqlite` 不可用时降级内存表**：功能全在，但重启即失忆（`engines.node >= 24` 已声明）。
- **私有 provider 不收敛成官方 `spawn`**：provider 名是四类 worker 的唯一路由键，收敛会让
  PTC / minimal 人格静默塌缩。理由与契约测试见 [PLATFORM.md](PLATFORM.md#关于把私有-provider-收敛成官方-spawn-的决策)。

---

## 四、仓库余留

- npm 上有一个 `0.0.0-stage` 占位版本（staged publish 机制自动创建，`latest` 指向 `0.2.0`）。
  当前 token 是 bypass-2FA 的 automation token，npm 策略禁止它做 `unpublish`，所以删不掉。
  **无害**，安装时拿的是 `latest`。
- 若要清掉它，需在 npm 网页上人工删除（需要 2FA 确认）。
