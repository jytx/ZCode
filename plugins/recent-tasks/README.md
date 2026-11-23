# recent-tasks（最近任务）

ZCode 扩展：跨项目列出最近更新的任务，点一下就跳到它所在的工作区并选中它。
解决「项目多了，顺手起的任务事后找不到」的问题。不改宿主代码，零第三方依赖。

## 入口

- 左侧导航「插件市场」下方的「最近任务」：在右侧面板打开本视图。
- 右侧面板「新标签页」启动页的「扩展」分区：同一个视图，这里还能看到「需要授权」「扩展已停止」等状态。
- 导航入口的角标是**待处理任务数**（有任务在等用户处理时显示），悬停说明里带运行中与有新进展的数量。

## 面板

- 按更新时间倒序平铺，一行一个任务。
- 每行两行信息：标题 + 状态标签（运行中 / 待处理）；第二行是**所属工作区的目录名**、标记（置顶、远程、离线、有新进展、上次看的）和相对时间。
- **未读的任务在标题前有一个蓝点**，与桌面侧栏的蓝点是同一份数据（宿主 tasks-index 的未读标记）：后台跑完、用户还没看过的任务会亮蓝点，点进去看过之后自动熄灭。
- **点一行就跳过去**：主窗口切到该任务所在的工作区并选中它，面板随之切回前台。
- 搜索按标题过滤；「显示已归档」默认关闭。
- 列表实时更新：宿主的会话列表一变，面板随之刷新（密集变化会合并，避免频繁重画）。

## 上次位置

插件在自己的数据目录（`~/.zcode/cli/plugins/data/<插件 id>/recent-tasks.json`）记住每个工作区
最近一次打开的任务与时间。它带来两个效果：

- 上次打开过的那条标「上次看的」；之后又更新的任务标「有新进展」。
- 导航角标的悬停说明里包含「N 个有新进展」。

写失败只记日志，不影响跳转。

## 权限

清单申请 `sessions.write`，首次需要在授权对话框里确认一次。原因：宿主把「打开会话」归在写档，
只读档无法跳转。对话框会列出写档的全部能力（新建、发消息、中断、改名、打开、归档、置顶），
本扩展实际只用其中的「打开会话」。

授权入口有两个：打开面板后提示条上的「授权」按钮，或启动页「扩展」分区的「需要授权」行。
在启动页授权之后打开面板，扩展会自动重新订阅任务列表，不需要再点按钮。

## 目录

```
.zcode-plugin/plugin.json     清单：视图、两个入口插槽、权限档位与协议版本
extension/index.mjs           入口：订阅列表、注册视图与工具、装配状态
extension/taskList.mjs        列表的合并、排序、派生字段（纯函数）
extension/viewModel.mjs       视图模型构建 + 界面文案 + 相对时间格式化
extension/memory.mjs          上次位置记忆的读写（纯函数 + 文件 IO）
extension/tools.mjs           动作工具：打开任务、请求授权
extension/panel-core.mjs      页面脚本：状态、纯函数、宿主桥
extension/panel-view.mjs      页面脚本：DOM 渲染与事件分发
ui/panel.template.html        页面模板（样式与占位符）
ui/index.html                 构建产物：模板 + 内联脚本，清单里的视图入口指向它
scripts/build-panel.mjs       构建脚本：内联两个页面脚本
scripts/smoke-test.sh         测试入口
```

页面与扩展进程之间：视图模型只走资源 `ui://<pluginId>/state`（页面订阅后被通知刷新），
动作只走工具。列表的唯一事实源是宿主，扩展只缓存最近一份快照，不落盘业务数据。

### 为什么页面要构建

宿主沙箱只服务一个 HTML 文件（`packages/desktop/src/main/pluginSandbox/protocol.ts`），
页面没法引同源脚本；而视图入口必须是插件根目录下的一个文件（宿主直接读它的内容）。
所以页面脚本以源文件形式维护（各自不超过 300 行），构建时内联成 `ui/index.html`。

改完 `extension/panel-core.mjs` 或 `extension/panel-view.mjs` 要重新构建：

```bash
node scripts/build-panel.mjs
```

## 未读蓝点的来源

蓝点不是扩展自己算的，而是宿主透传的未读标记（扩展列表行里的 `unreadAt`）：

- 宿主在后台任务跑完时写入未读标记，用户查看该任务后清除——与桌面侧栏蓝点同一份数据、同一套判定。
- 宿主把该标记放进扩展的列表行（`packages/shared/src/extension-host/sessions.ts` 的 `sessionListRowSchema`，
  由 `packages/services/src/extensions/sessionListPump.ts` 从任务投影映射过来）。
- 因此：**宿主版本不支持这个字段时面板不显示蓝点**，其它功能不受影响（本插件对新字段是可选的）。

## 安装与更新

插件通过本地市场 `zcode-local-dev`（目录 `~/.zcode-local-marketplace`）安装，命令用 ZCode 自带的命令行：

```bash
ZCODE=/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
node "$ZCODE" plugins validate <本目录>
node "$ZCODE" plugins marketplace update zcode-local-dev
node "$ZCODE" plugins install recent-tasks@zcode-local-dev
```

安装会把当前目录拷贝进 ZCode 的插件缓存。改完代码后对已安装的插件再执行一次 `install`，
缓存就会被当前目录覆盖（已实测，不需要提升版本号）。

**改完入口代码后要重启 ZCode，不能只「重新加载扩展」。** 扩展进程用
`import(pathToFileURL(entry).href)` 加载入口，同一进程内再次 import 命中 Node 的 ESM 模块缓存，
不会重新读文件——「重新加载扩展」因此读不到新代码（日志里会表现为「activated in 2ms」）。
重启 ZCode 会新建扩展进程，这时才真正读到新代码。

面板页面（`ui/index.html`）每次打开视图都会重读，所以纯页面改动重启前也能生效。

卸载：`node "$ZCODE" plugins uninstall recent-tasks`。卸载是彻底清除，命令会要求确认；
在脚本等非交互环境里必须加 `--force`，否则直接拒绝。

## 测试

```bash
bash scripts/smoke-test.sh
```

依次执行：构建面板页面、行数门禁（源文件不超过 300 行）、语法检查、类型检查（JSDoc + strict）、
清单校验（直接调用宿主的清单校验代码）、扩展入口冒烟测试（假宿主）、面板页面冒烟测试（最小 DOM 桩）。
日志写入仓库的 `logs/recent-tasks/smoke-test.log`。依赖仓库的 Node 24（nvm）、TypeScript 与 tsx。

## 已知限制

- 只列侧栏里能看到的任务；subagent、workflow 这类子会话不在其中（宿主没有向扩展开放这条查询）。
- 远程工作区的任务能列出来，但不能从这里打开（宿主的写档只到本机 Host），面板会给出提示。
- 列表行没有项目名，显示的是工作区目录名；单目录项目下目录名就是项目名。
- 只在桌面端可用；插件需要在用户层启用。
- 最多显示最近更新的 1000 个任务。
- 打开任务后，左侧栏会切换工作区并高亮该任务；任务所在项目若处于折叠状态，不会自动展开。
