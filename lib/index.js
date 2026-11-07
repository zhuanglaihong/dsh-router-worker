/**
 * dsh-subagent-tree — host 半（node 侧）。
 *
 * 本插件的全部工作都在浏览器里（把子会话画进左侧会话列表），host 侧不需要
 * 注册服务、监听事件或开路由。这里只留一个可卸载的空挂载点，让 bundle 里的
 * `insert` 行有东西可加载，并打一行日志方便在 desktop-next.log 里确认它活着。
 *
 * 之所以保留 host 半而不是只做一个 client-only 包：DSH 的 bundle 行指向包的
 * `main`，缺了它加载器会在启动时报模块解析失败，整个 bundle 都会被跳过。
 */

/** 插件激活时调用；返回注销器（仓库里没注册任何东西，所以注销器只打日志）。 */
export function apply(ctx) {
  ctx.logger?.info?.('dsh-subagent-tree: host half loaded (sidebar tree is drawn by the client half)')
  return () => {
    ctx.logger?.info?.('dsh-subagent-tree: host half unloaded')
  }
}

/** 本包要求的宿主服务：没有（纯客户端渲染）。 */
export const inject = []
