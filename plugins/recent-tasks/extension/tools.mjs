// 面板的动作工具：打开任务、请求授权。
//
// 工具都从视图工具表暴露给页面（extension-host.md §8 的写法一）：页面调 tools/call，
// 宿主把它转给扩展进程里的 MCP server。每次调用返回一个结构化结果，页面据此给提示；
// 失败不抛异常，避免页面只能看到一句「未知错误」。
//
// 依赖注入：状态（任务列表、订阅状态、记忆）由 index.mjs 持有，这里通过 deps 访问，
// 这样两个模块不会互相 import 形成环。
//
// 入参校验与错误码读取也放在本文件：它们只服务于这些工具，单独成文件反而多一次跳转。

import { recordOpened, writeMemory } from "./memory.mjs";

/** 能打开会话的两个档位：sessions.fullAccess 包含 sessions.write。 */
/** @type {readonly ["sessions.write", "sessions.fullAccess"]} */
const OPEN_SESSION_GRANTS = ["sessions.write", "sessions.fullAccess"];

/**
 * 扩展错误：宿主统一抛 ExtensionError，带稳定的 code。
 * @typedef {object} HostError
 * @property {string} [code]
 * @property {string} [message]
 */

/**
 * 已授予的档位是否包含打开会话所需的 sessions.write。
 * @param {string[]} granted
 * @returns {boolean}
 */
function canOpenSessions(granted) {
  return granted.some((grant) => OPEN_SESSION_GRANTS.includes(/** @type {typeof OPEN_SESSION_GRANTS[number]} */ (grant)));
}

/**
 * 工具入参校验：宿主不替插件校验，这里只接受非空的 { sessionId }。
 * @param {unknown} input
 * @returns {string | null}
 */
function readSessionId(input) {
  const value =
    input !== null && typeof input === "object" ? /** @type {{sessionId?: unknown}} */ (input).sessionId : undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * 扩展错误的稳定错误码；不是扩展错误时记 unknown。
 * @param {unknown} error
 * @returns {string}
 */
function readCode(error) {
  const code = error !== null && typeof error === "object" ? /** @type {HostError} */ (error).code : undefined;
  return typeof code === "string" ? code : "unknown";
}

/**
 * 扩展错误的说明文字（宿主保证不含路径与正文）；没有时退回错误码。
 * @param {unknown} error
 * @returns {string}
 */
function readMessage(error) {
  if (error instanceof Error && error.message.length > 0) return error.message;
  const message = error !== null && typeof error === "object" ? /** @type {HostError} */ (error).message : undefined;
  return typeof message === "string" && message.length > 0 ? message : readCode(error);
}

/**
 * 日志用的一行错误摘要。
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  return `${readCode(error)} ${readMessage(error)}`;
}

/**
 * 动作工具依赖。
 *
 * list 与 listState 用取值函数传入而不是直接传值：宿主会在订阅回调里重新赋值它们，
 * 直接传的话这里拿到的永远是初始快照（空列表）。
 *
 * @typedef {object} ToolDeps
 * @property {() => import("./taskList.mjs").TaskList} getList 宿主任务列表（取标题用）
 * @property {() => import("./taskList.mjs").ListState} getListState 列表订阅状态（判断是否要重新订阅）
 * @property {{current: import("./memory.mjs").Memory}} memoryBox 记忆的可变容器
 * @property {Map<string, {workspacePath: string, workspaceIdentity?: string, sessionId: string}>} sessionRefs 会话引用
 * @property {() => void} refresh 操作后刷新角标与页面
 * @property {() => void} subscribeList 重新订阅任务列表
 * @property {() => Promise<void>} refocusView 把面板切回前台
 */

/**
 * 宿主上下文中，本模块用到的部分。
 * @typedef {object} ToolHost
 * @property {{id: string, dataPath: string}} extension
 * @property {{warn(message: string): void}} log
 * @property {{openSession(input: {sessionId: string}): Promise<{status: "opened" | "unavailable", reason?: string}>}} sessions
 * @property {{request(): Promise<{granted: string[]}>}} grants
 */

/**
 * 造出全部动作工具。
 * @param {ToolHost} ctx 宿主上下文
 * @param {ToolDeps} deps 状态与回调
 * @returns {Record<string, (input: unknown) => Promise<object>>}
 */
export function createTools(ctx, deps) {
  /**
   * 记住这个工作区：上次打开的是哪条任务、什么时候打开的。写失败只记日志，不影响跳转。
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  const rememberOpened = async (sessionId) => {
    const reference = deps.sessionRefs.get(sessionId);
    if (!reference) return;
    const title = deps.getList().rows.get(sessionId)?.title ?? "";
    deps.memoryBox.current = recordOpened(deps.memoryBox.current, reference, title, Date.now());
    if (!(await writeMemory(ctx.extension.dataPath, deps.memoryBox.current))) {
      ctx.log.warn("[recent-tasks] 写入上次位置失败");
    }
  };

  /**
   * 打开任务：让主窗口切到它所在的工作区并选中它。
   * @param {unknown} input
   * @returns {Promise<{ok: boolean, status: string, reason?: string | null, code?: string, message?: string}>}
   */
  const openTask = async (input) => {
    const sessionId = readSessionId(input);
    if (sessionId === null) return { ok: false, status: "error", code: "invalid-input" };
    try {
      const result = await ctx.sessions.openSession({ sessionId });
      if (result.status === "opened") {
        await rememberOpened(sessionId);
        await deps.refocusView();
        deps.refresh();
      }
      return { ok: result.status === "opened", status: result.status, reason: result.reason ?? null };
    } catch (error) {
      ctx.log.warn(`[recent-tasks] 打开任务失败 ${describeError(error)}`);
      return { ok: false, status: "error", code: readCode(error), message: readMessage(error) };
    }
  };

  /**
   * 请宿主弹授权对话框。已授权时不弹窗，直接返回当前档位；
   * 档位够用而列表订阅不在就绪态时（未授权过、或宿主一度不可用）顺带重新订阅。
   * allowed 是档位是否够打开会话，页面据此区分「用户没授权」与「授权请求出错」。
   * @returns {Promise<{granted: string[], allowed: boolean, subscribed: boolean, code?: string, message?: string}>}
   */
  const requestGrant = async () => {
    try {
      const { granted } = await ctx.grants.request();
      const allowed = canOpenSessions(granted);
      const subscribed = allowed && deps.getListState().phase !== "ready";
      if (subscribed) deps.subscribeList();
      return { granted, allowed, subscribed };
    } catch (error) {
      ctx.log.warn(`[recent-tasks] 请求授权失败 ${describeError(error)}`);
      return { granted: [], allowed: false, subscribed: false, code: readCode(error), message: readMessage(error) };
    }
  };

  return { openTask, requestGrant };
}

export { canOpenSessions, describeError, readCode, readMessage, readSessionId };
