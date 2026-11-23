// 最近任务扩展的入口（宿主契约见 docs/plugins/extension-host.md §7、§8、§17）。
//
// 职责：订阅宿主的会话列表投影（与桌面侧栏任务列表同一份数据），组装成视图模型交给页面；
// 提供动作工具（打开任务、请求授权、读预览、置顶、归档、改名）；记住每个工作区上次打开的任务；
// 并把待处理任务数写到左侧导航入口的角标。
//
// 设计约束：
// - 任务列表的唯一事实源是宿主：这里只缓存最近一份快照，不落盘业务数据，不自行补全或改写。
// - 分组、排序、统计、文案都在扩展进程做完（taskList / viewModel / texts），页面只做 DOM 渲染与事件分发。
//   这样页面能压在单文件 300 行以内——沙箱只服务一个 HTML 文件，同源脚本加载不到。
// - 记忆（memory.mjs）是插件自己的使用痕迹，存插件数据目录，与宿主状态无关。
// - 动作工具在 tools.mjs，本文件只做装配，不承载业务分支。
// - 类型用 JSDoc 表达：扩展入口由宿主动态 import，纯 JS、无构建链（与仓库内其他本地插件一致）。

import { applyListEvent, emptyList } from "./taskList.mjs";
import { buildViewModel } from "./viewModel.mjs";
import { emptyMemory, findEntry, readMemory } from "./memory.mjs";
import { createTools, describeError, readCode } from "./tools.mjs";

/** @typedef {import("./taskList.mjs").ListEvent} ListEvent */
/** @typedef {import("./taskList.mjs").ListState} ListState */
/** @typedef {import("./taskList.mjs").TaskList} TaskList */
/** @typedef {import("./memory.mjs").Memory} Memory */
/** @typedef {import("./tools.mjs").HostError} HostError */

// ---------------------------------------------------------------------------
// 常量与宿主侧类型
// ---------------------------------------------------------------------------

/** 清单 `contributes.views[].id` 与 `slots.*[].target.view` 的本地 id。 */
const VIEW_ID = "recent-tasks";
/** 清单 `slots.nav.primary[].id`：角标与悬停说明写到这个条目上。 */
const NAV_ITEM_ID = "open";
/**
 * 通知页面的合并间隔（毫秒）。宿主任务投影在流式输出时高频变化，
 * 逐次通知会让页面整份重读重画；合并后用户感知不到延迟，但页面不会被淹没。
 */
const NOTIFY_INTERVAL_MS = 300;

/**
 * 导航入口的角标与悬停说明（slots.update 补丁中本扩展用到的字段）。
 * @typedef {object} SlotPatch
 * @property {number | null} badge 待处理任务数；0 用 null 清除
 * @property {string} tooltip
 */

/**
 * 打开中的视图实例（宿主传入，extension-host.md §8 的 ViewInstance）。
 * @typedef {object} ViewInstance
 * @property {string} id
 * @property {(uri: string) => void} notify 只发给订阅了该 uri 的页面
 * @property {(listener: () => void) => {dispose(): void}} onDidClose
 */

/**
 * 视图工具：inputSchema 是普通 JSON Schema，宿主原样放进 tools/list、不替插件校验入参。
 * @typedef {object} ViewTool
 * @property {string} description
 * @property {{type: "object", properties: object, required?: string[]}} inputSchema
 * @property {(input: unknown) => unknown} run 返回普通对象时宿主放进 structuredContent
 */

/**
 * 视图定义（写法一「宿主帮手」，extension-host.md §8）。
 * @typedef {object} ViewDefinition
 * @property {string} entry 页面 HTML，相对插件根目录
 * @property {(view: ViewInstance) => void} onDidOpen
 * @property {Record<string, ViewTool>} tools
 * @property {Record<string, {mimeType: string, read: () => string}>} resources
 */

/**
 * 宿主注入的扩展上下文中，本扩展用到的部分（与 @zcode-dev/plugin-api 的同名成员同形）。
 * @typedef {object} HostContext
 * @property {{id: string, dataPath: string}} extension
 * @property {{info(message: string): void, warn(message: string): void}} log
 * @property {{update(itemId: string, patch: SlotPatch, scope: "app"): void}} slots
 * @property {{register(id: string, definition: ViewDefinition): {dispose(): void},
 *             open(id: string, scope: "app"): Promise<void>}} views
 * @property {{get(): Promise<{locale: string}>,
 *             onDidChange(listener: (event: {locale: string}) => void): {dispose(): void}}} env
 * @property {{onDidChangeList(listener: (event: ListEvent) => void,
 *                              onError?: (error: HostError) => void): {dispose(): void},
 *             openSession(input: {sessionId: string}): Promise<{status: "opened" | "unavailable", reason?: string}>}} sessions
 * @property {{request(): Promise<{granted: string[]}>}} grants
 */

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 扩展激活：装配订阅、视图与工具。闭包变量是本扩展唯一的可变状态。
 * @param {HostContext} ctx 宿主注入的扩展上下文
 * @returns {Promise<void>}
 */
export async function activate(ctx) {
  /** @type {TaskList} */
  let list = emptyList();
  /** @type {ListState} */
  let listState = { phase: "connecting", errorCode: null };
  /** 记忆的可变容器：tools.mjs 要写入它，这里负责读盘与建视图模型。 @type {{current: Memory}} */
  const memoryBox = { current: emptyMemory() };
  /** @type {string} */
  let locale = "zh-CN"; // ctx.env.get 返回前的过渡值
  /** @type {{dispose(): void} | null} */
  let listSubscription = null;
  /** 打开中的视图实例：列表变化时逐个通知。 @type {Set<ViewInstance>} */
  const views = new Set();
  /** 视图模型资源的 URI；页面按结尾匹配它。 */
  const stateUri = `ui://${ctx.extension.id}/state`;
  /** 会话 id → 会话引用：写记忆时要用工作区信息。 @type {Map<string, {workspacePath: string, workspaceIdentity?: string, sessionId: string}>} */
  const sessionRefs = new Map();

  /** 视图模型：页面唯一的读入口。 */
  const currentViewModel = () =>
    buildViewModel({
      list,
      listState,
      locale,
      lookupLastOpened: (key) => findEntry(memoryBox.current, key),
    });

  /**
   * 数据变了：通知所有打开中的页面重新读取视图模型。
   *
   * 节流：宿主的任务投影在 Agent 流式输出时高频变化（活动时间、未读标记都在动），
   * 逐次通知会让页面每次都整份重读视图模型并重建全部行，表现为「点了没反应，等很久」。
   * 这里把连续的通知合并到一个固定间隔里发一次；期间的状态变化由下一次通知带过去。
   */
  /** @type {ReturnType<typeof setTimeout> | null} */
  let notifyTimer = null;
  let notifyPending = false;
  const flushNotify = () => {
    notifyTimer = null;
    if (!notifyPending) return;
    notifyPending = false;
    for (const view of views) view.notify(stateUri);
  };
  const notifyViews = () => {
    notifyPending = true;
    if (notifyTimer === null) notifyTimer = setTimeout(flushNotify, NOTIFY_INTERVAL_MS);
  };

  /** 把待处理任务数写到左侧导航入口的角标与悬停说明。 */
  const refreshSlot = () => {
    const counts = currentViewModel().counts;
    const zh = locale.toLowerCase().startsWith("zh");
    const parts = [];
    if (counts.needsAttention > 0) {
      parts.push(zh ? `${counts.needsAttention} 个待处理` : `${counts.needsAttention} need attention`);
    }
    if (counts.running > 0) parts.push(zh ? `${counts.running} 个运行中` : `${counts.running} running`);
    if (counts.unseen > 0) parts.push(zh ? `${counts.unseen} 个有新进展` : `${counts.unseen} updated`);
    if (counts.unread > 0) parts.push(zh ? `${counts.unread} 个未读` : `${counts.unread} unread`);
    try {
      ctx.slots.update(
        NAV_ITEM_ID,
        {
          badge: counts.needsAttention > 0 ? counts.needsAttention : null,
          tooltip:
            parts.length === 0
              ? zh
                ? "没有待处理或运行中的任务"
                : "No tasks need attention"
              : parts.join(zh ? "，" : ", "),
        },
        "app",
      );
    } catch (error) {
      // 角标只是辅助信息：更新失败不能影响列表本身，记一条告警即可。
      ctx.log.warn(`[recent-tasks] 更新导航角标失败 ${describeError(error)}`);
    }
  };

  /**
   * 订阅以错误结束（未授权、宿主不可用等）：记下错误码让页面给出对应入口。
   * @param {HostError} error
   */
  const failList = (error) => {
    listSubscription?.dispose();
    listSubscription = null;
    listState = { phase: "failed", errorCode: readCode(error) };
    ctx.log.warn(`[recent-tasks] 任务列表订阅结束 ${describeError(error)}`);
    notifyViews();
  };

  /**
   * （重新）订阅任务列表；上一个订阅若仍有效先释放，保证同一时刻只有一个监听。
   * 状态变为 connecting 时也通知页面，让面板立即显示加载中，而不是停留在上一次的失败提示上。
   */
  const subscribeList = () => {
    listSubscription?.dispose();
    listState = { phase: "connecting", errorCode: null };
    notifyViews();
    listSubscription = ctx.sessions.onDidChangeList((event) => {
      list = applyListEvent(list, event);
      for (const row of list.rows.values()) {
        sessionRefs.set(row.session.sessionId, {
          workspacePath: row.session.workspacePath,
          ...(row.session.workspaceIdentity ? { workspaceIdentity: row.session.workspaceIdentity } : {}),
          sessionId: row.session.sessionId,
        });
      }
      listState = { phase: "ready", errorCode: null };
      notifyViews();
      refreshSlot();
    }, failList);
  };

  /** 重新聚焦本面板：跳到别的工作区后，侧栏会把本面板的标签排到末尾。失败只记日志。 */
  const refocusView = async () => {
    try {
      await ctx.views.open(VIEW_ID, "app");
    } catch (error) {
      ctx.log.warn(`[recent-tasks] 重新聚焦面板失败 ${describeError(error)}`);
    }
  };

  const tools = createTools(
    { extension: ctx.extension, log: ctx.log, sessions: ctx.sessions, grants: ctx.grants },
    {
      getList: () => list,
      getListState: () => listState,
      memoryBox,
      sessionRefs,
      refresh: () => {
        refreshSlot();
        notifyViews();
      },
      subscribeList,
      refocusView,
    },
  );

  /** 界面语言只影响文案与角标说明。 @param {{locale: string}} event */
  const applyLocale = (event) => {
    locale = event.locale;
    refreshSlot();
    notifyViews();
  };
  // 首个语言值异步到达，之后跟随变化。
  ctx.env.onDidChange(applyLocale);
  ctx.env.get().then(applyLocale, (error) => ctx.log.warn(`[recent-tasks] 读取界面语言失败 ${describeError(error)}`));

  ctx.views.register(VIEW_ID, {
    entry: "./ui/index.html",
    onDidOpen: (view) => {
      views.add(view);
      view.onDidClose(() => views.delete(view));
      // 订阅可能在面板没打开时以错误结束，例如用户事后才在启动页授权：宿主不会自动重订，
      // 面板打开时再试一次。仍未授权时这次订阅立刻以 not-granted 结束，回到原来的提示；不会弹窗。
      if (listState.phase === "failed") subscribeList();
    },
    tools: {
      openTask: {
        description: "在主窗口打开指定任务：切换到它所在的工作区并选中它",
        inputSchema: { type: "object", properties: { sessionId: { type: "string" } }, required: ["sessionId"] },
        run: tools.openTask,
      },
      requestGrant: {
        description: "请宿主弹出授权对话框；授权后重新订阅任务列表",
        inputSchema: { type: "object", properties: {} },
        run: tools.requestGrant,
      },
    },
    resources: {
      [stateUri]: { mimeType: "application/json", read: () => JSON.stringify(currentViewModel()) },
    },
  });

  // 记忆是插件自己的数据，读失败不影响面板。
  memoryBox.current = await readMemory(ctx.extension.dataPath);
  subscribeList();
}

/** 扩展停用：注册与监听由宿主按扩展生命周期回收，这里没有需要手动清理的资源。 @returns {void} */
export function deactivate() {}
