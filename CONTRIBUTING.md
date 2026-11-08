# 贡献指南

谢谢你有兴趣改进 `dsh-subagent-tree`。

## 仓库结构

```
├── lib/                      宿主半 + 浏览器半
│   ├── index.js              入口：声明 preset、注册 provider、装 runtime、开 HTTP 路由
│   ├── client.js             renderer 半：侧栏子对话树 + 设置页（lazy-CJS 单 bundle）
│   ├── store.js             工单表（node:sqlite，降级内存）
│   ├── dispatcher.js        派单泵（对宿主名额拒绝作反应）
│   ├── outbox.js            结果回流（退避重试、重启续投）
│   ├── runtime.js           把上面几件组装起来 + 启动恢复
│   ├── watchdog.js          卡死巡检（纯逻辑、可注入假时钟）
│   ├── platform.js          平台判定纯函数（显式 platform 参数）
│   └── worker-providers.js  两类自建 worker 后端
├── presets/router-worker/   「Router 项目经理模式」的 12 行 composition（从 dsh-multitask 分叉）
├── test/                    零依赖单测（node:test）
├── docs/                    设计文档、三平台边界、截图
├── .github/workflows/       三平台 CI + 发布工作流
├── cordis.patch.yml         要插进 profile 的那一行 bundle
└── package.json             dsh.bundle.patch / dsh.client / files / publishConfig
```

`presets/router-worker/` 里的大部分文件是从 `dsh-multitask` 1.3.3 **逐字复制**的
（MIT，署名保留在 `LICENSE`）。为保持与上游 diff 干净，**尽量别改它们**；确需改动时
在 commit message 里写明理由，并同步检查 `lib/platform.js` 里镜像的分支是否还一致。

## 本地开发

需要 Node **>= 24**（`node:sqlite`）。

```bash
npm test                 # 四个测试文件 / 39 用例，零外部依赖
npm pack --dry-run       # 检查将进入 tarball 的文件清单
```

本项目**没有运行时依赖、没有构建步骤**。`lib/client.js` 会被 DSH 直接作为
浏览器 bundle 加载，所以：

- 不要在浏览器半里 `require` 平台种子表之外的包；`react` 的 `require` 必须包
  `try/catch`（种子表缺 react 时只跳过设置页，不能让整个 bundle 抛错）。
- 不要用 `ctx.document` 这类 cordis 受控属性（未声明 `inject` 会抛
  `cannot get property "document" without inject`，曾导致 0.1.0 启动失败）。
- 新增服务依赖用 `ctx.inject([...], cb)` **另开子 fiber**，不要塞进主 `inject`——
  任一服务缺席会把整个 client fiber 拖到 PENDING，连侧栏树都不显示。
- 只认业务属性 `data-row-key`；**不要修改宿主会话行**（不插子节点、不改内联样式）。
  自定义皮肤（如 `dsh-claude-style`）会把行包进一层 box 并整体搬动，见
  README 的「兼容自定义皮肤」与 `test/sidebar-structure.test.mjs`。
- CSS 颜色只用 `--dsw-alias-*` 语义令牌，尺寸从 `--dsw-font-size-sm` 推导，别写死像素。

## 装进自己的 DSH 试

```bash
dsh plugin --profile <profile> add /path/to/dsh-subagent-tree
```

或者在插件管理器里 `install_bundle` 指向这个目录。改了宿主半（`lib/index.js`、
`presets/`）后需要**完整退出 ⌘Q 再重开** DSH NEXT；只改浏览器半时也可能要重启，
因为 client bundle 是按 revision 加载的。

## 提交前

1. `npm test` 全绿；
2. `npm pack --dry-run` 的清单符合预期（新文件要进 `package.json` 的 `files`）；
3. 新增行为要有一个对应的零依赖单测（参考 `test/*.test.mjs`）；
4. `CHANGELOG.md` 补一行；
5. 若动了平台分支，同步更新 `docs/PLATFORM.md` 的发布口径。

## 报告问题

请用 `.github/ISSUE_TEMPLATE/` 里的模板。最有用的三样东西：DSH 版本、是否装了
自定义皮肤（尤其 `dsh-claude-style`）、以及 `~/.dsh/logs/desktop-next.log` 里
含 `dsh-subagent-tree` / `ROUTER-` 的行。

## 许可

MIT。贡献即视为同意以 MIT 发布。上游 `dsh-multitask` 的版权声明保留在 `LICENSE`。
