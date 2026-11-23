# 最近任务面板：范围与决策记录

> 状态：已落地（2026-11-23）。
> 对象：`plugins/recent-tasks`（版本 0.1.0，本地市场 `zcode-local-dev` 安装）。
> 依据：`docs/plugins/extension-host.md`（宿主扩展契约）、当前插件源码、`~/.zcode/v2/logs/` 的实际运行日志。
> 本文记录**最终做了什么**和**为什么不做**，不再保留已经过时的功能规划。

## 一、最终落地的范围

| 能力 | 说明 |
| --- | --- |
| 跨项目列任务 | 平铺，按更新时间倒序，不分组 |
| 每行显示目录名 | 跨项目时分辨「这条属于哪个项目」的唯一依据（单目录项目下目录名就是项目名） |
| 点一行就跳过去 | 主窗口切到该任务所在的工作区并选中它 |
| 未读蓝点 | 与桌面侧栏同一份未读数据，标题前标一个蓝点 |
| 记住上次位置 | 每个工作区最近打开的任务标「上次看的」，之后又更新的标「有新进展」 |
| 导航角标 | 待处理任务数；悬停说明里带运行中、有新进展、未读的数量 |
| 搜索与归档过滤 | 按标题过滤，「显示已归档」默认关闭 |

## 二、评审中被否决的功能

| 功能 | 结论 |
| --- | --- |
| 按工作区分组 | **不做**。分组视图点开后要等很久（宿主任务投影在流式输出时高频变化，页面整份重读重画），平铺更稳。 |
| 会话预览 | **不做**。用「记住上次位置 + 目录名」认任务已经够用。 |
| 置顶 / 归档 / 改名 | **不做**。宿主能力是现成的，但对「找回任务」这个目标没有帮助。 |
| 改宿主做项目归属 | **不做**。当前数据源没有项目归属，目录名已够用。 |
| 子会话 | **暂不做**，见 §四。 |

平铺之后仍然要防抖：通知合并（扩展侧 300ms）与重读合并（页面侧 150ms）各挡一层，
否则密集输出时页面会被反复重建。

## 三、核实过的事实

| 事实 | 依据 |
| --- | --- |
| 面板的数据源是 Window Host 的控制器投影，与桌面侧栏同一份 | `packages/services/src/extensions/sessionListPump.ts` |
| 控制器投影的行**没有项目归属**，但带 `workspacePath` | `WindowHostControllerTaskRow` 定义 |
| 另一条路 `sessions.listSessions` 带项目归属，但只列根会话（`roots: true`） | `packages/session-control/src/contract/app.ts` |
| 「打开会话」属于**写档** `sessions.write`，本插件申请该档 | `packages/shared/src/extension-host/capabilities.ts` |
| 写档动作只作用于本机 Host；远端来源的会话能列出、不能写 | 规格 §17.2 |
| 扩展视图与插槽只在桌面本机 Host 注册 | `packages/desktop/src/host/index.ts`、规格 §2 |
| 桌面客户端连 SaaS 后端时，扩展机制照常可用（扩展在客户端侧） | `packages/desktop/src/main/desktopRuntimeEnv.ts` |

最后两条合起来说明：**主要用 SaaS 后端不影响本插件的可用性**，只有纯浏览器访问 SaaS 才没有扩展视图。

## 四、子会话：能做，但有约束

**约束一：能力表里没有这条能力。** 扩展能调用的会话能力是 `listSessions` / `listProjects` / `readSession`
等固定几项，没有「按父会话列出子会话」；而 `listSessions` 走 CLI 会话库查询，固定用 `roots: true`，只要根会话。

**约束二：数据源在别处。** 子会话的真实数据源是 agent 的 wire 查询 `session/list` 带 `parentSessionId` 参数，
已有实现接在 **UI 插件桥**（`IPluginUiBridgeService.listChildSessions`）上，扩展能力表里没有对应项。

**可选路径：**

| 路径 | 做法 | 代价 |
| --- | --- | --- |
| 甲 | 能力表加一行「列出子会话」，后端复用 `listAgentSessions({ parentSessionId })` | 要改宿主，只加不改语义，对已有插件无影响 |
| 乙 | 把最近任务面板做成 UI 插件，走 UI 插件桥 | 不用改宿主，但面板必须挂在某个会话上，跨项目列任务做不了 |
| 丙 | 暂时不做 | 零成本，子会话场景空缺 |

当前走丙。子会话在「最近任务」里的价值有限——它依附于父会话，父会话出现在列表里时就跟着能看到。

## 五、未读蓝点：需要宿主透传一个字段

蓝点不是扩展自己算的。侧栏蓝点的判据是 `task.unreadAt`（tasks-index 的未读标记，
`packages/ui/src/lib/taskListItemPresentation.ts`），扩展拿不到的原因是**协议里没有这个字段**：

- 宿主控制器投影的行本来就带 `unreadAt`（`WindowHostControllerTaskRow.meta` 是完整的 `ZCodeTaskMeta`），
  但映射成扩展列表行时只挑了 title / updatedAt / archived / pinned，把它丢了。
- 所以改动是两处小改：列表行 schema 加可选字段 + 映射时带上（`packages/shared/src/extension-host/sessions.ts`、
  `packages/services/src/extensions/sessionListPump.ts`）。按 §17.6「只加字段不升版」，协议版本不变。

**代价：宿主不支持这个字段时（例如已发布的旧版本 ZCode），面板不显示蓝点，其它功能不受影响。**
