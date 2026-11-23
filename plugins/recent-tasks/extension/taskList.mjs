// 任务列表的纯计算：类型定义、列表事件合并、展示排序、分组、状态统计。
//
// 全部是不修改入参的纯函数，不依赖宿主；订阅、视图注册与工具装配在入口 index.mjs。
// 类型形状来自宿主契约（docs/plugins/extension-host.md §17.3、§17.5、§17.6）。

/**
 * 宿主列表快照的行数上限（extension-host.md §17.5 的 SESSION_LIST_MAX_ROWS）。
 * 超过后宿主只给最新的这些行并标记 truncated；类型包不导出运行时常量，所以在这里同名声明。
 * @type {number}
 */
export const SESSION_LIST_MAX_ROWS = 1000;

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 会话引用：与写动作的入参同一格式（extension-host.md §17.6）。
 * @typedef {object} SessionRef
 * @property {"app"} kind
 * @property {string} sourceServerId
 * @property {string} workspacePath
 * @property {string} [workspaceIdentity] 仅远程工作区才有
 * @property {string} sessionId
 */

/**
 * 列表行 v1（extension-host.md §17.5）：宿主任务投影映射后的任务行。
 * @typedef {object} TaskRow
 * @property {SessionRef} session
 * @property {string} title
 * @property {"idle" | "running" | "needs_attention"} status
 * @property {string} [updatedAt] ISO 时间
 * @property {number} [unreadAt] 未读标记（毫秒时间戳）；存在即未读，与桌面侧栏蓝点同一份数据
 * @property {boolean} [archived]
 * @property {boolean} [pinned]
 * @property {"online" | "offline"} sourceAvailability
 */

/**
 * 列表事件：订阅后的第一个事件总是 snapshot，之后是 delta。
 * @typedef {{kind: "snapshot", rev: number, sessions: TaskRow[], truncated?: true}
 *          | {kind: "delta", rev: number, upserted: TaskRow[], removed: SessionRef[]}} ListEvent
 */

/**
 * 列表缓存。不可变：每次事件都返回新对象，旧快照可以被在途的资源读取安全使用。
 * @typedef {object} TaskList
 * @property {ReadonlyMap<string, TaskRow>} rows 以会话引用键为键
 * @property {boolean} truncated
 */

/**
 * 列表订阅的状态：connecting 等首个事件，ready 已有数据，failed 订阅以错误结束。
 * @typedef {object} ListState
 * @property {"connecting" | "ready" | "failed"} phase
 * @property {string | null} errorCode failed 时的扩展错误码（例如 not-granted）
 */

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/**
 * 会话引用键：来源 + 工作区身份（远程用 identity，本地用路径）+ 会话 id。
 * @param {SessionRef} session
 * @returns {string}
 */
export function refKey(session) {
  const workspace = (session.workspaceIdentity ?? "").trim() || session.workspacePath;
  return `${session.sourceServerId}\0${workspace}\0${session.sessionId}`;
}

/** @returns {TaskList} 空列表缓存 */
export function emptyList() {
  return { rows: new Map(), truncated: false };
}

/**
 * 把一个列表事件合入缓存，返回新缓存（不修改入参）。
 * snapshot 整份替换；delta 先 upsert 再 remove，顺序与宿主投影一致。
 * @param {TaskList} list
 * @param {ListEvent} event
 * @returns {TaskList}
 */
export function applyListEvent(list, event) {
  if (event.kind === "snapshot") {
    const rows = new Map();
    for (const row of event.sessions) rows.set(refKey(row.session), row);
    return { rows, truncated: event.truncated === true };
  }
  const rows = new Map(list.rows);
  for (const row of event.upserted) rows.set(refKey(row.session), row);
  for (const ref of event.removed) rows.delete(refKey(ref));
  // delta 事件不带 truncated：只有行数掉到上限以下才能确定不再截断，否则沿用上一次的值。
  return { rows, truncated: list.truncated && rows.size >= SESSION_LIST_MAX_ROWS };
}

/**
 * 展示顺序：updatedAt 降序，缺失时间的排最后（Array.prototype.sort 是稳定排序）。
 * @param {TaskRow[]} rows
 * @returns {TaskRow[]}
 */
export function sortForDisplay(rows) {
  const stamp = (/** @type {TaskRow} */ row) => Date.parse(row.updatedAt ?? "") || 0;
  return rows.slice().sort((left, right) => stamp(right) - stamp(left));
}

/**
 * 处于某状态的任务数。
 * @param {TaskRow[]} rows
 * @param {TaskRow["status"]} status
 * @returns {number}
 */
export function countOf(rows, status) {
  return rows.filter((row) => row.status === status).length;
}

/**
 * 工作区的分组键：远程工作区用 identity（同名路径不同主机必须分开），本地用路径。
 * @param {SessionRef} session
 * @returns {string}
 */
export function workspaceKey(session) {
  return session.workspaceIdentity?.trim() || session.workspacePath;
}

/**
 * 面板里的一行任务：宿主那一行加上展示需要的派生字段。
 * @typedef {object} FlatTask
 * @property {string} sessionId
 * @property {string} title
 * @property {TaskRow["status"]} status
 * @property {string} [updatedAt]
 * @property {string} timeText 相对时间的显示文案（扩展侧算好，页面不重复实现本地化）
 * @property {boolean} pinned
 * @property {boolean} archived
 * @property {boolean} unread 宿主标记的未读（与桌面侧栏蓝点同一份数据）
 * @property {boolean} remote
 * @property {boolean} offline
 * @property {string} workspaceKey
 * @property {string} workspaceLabel 目录名（单目录项目下就是项目名）
 * @property {boolean} unseen 这个工作区在我上次看过之后又有更新
 * @property {boolean} lastOpened 上次打开的正是这一条
 */

/**
 * 把宿主的一行转成面板里的一行。
 * @param {TaskRow} row
 * @param {(key: string) => {sessionId: string, openedAt: number} | null} lookupLastOpened 查工作区上次打开的任务
 * @param {(iso: string | undefined, now: number) => string} formatTime 相对时间的本地化格式化
 * @returns {FlatTask}
 */
export function toFlatTask(row, lookupLastOpened, formatTime) {
  const key = workspaceKey(row.session);
  const lastOpened = lookupLastOpened(key);
  const updatedAt = Date.parse(row.updatedAt ?? "") || 0;
  return {
    sessionId: row.session.sessionId,
    title: row.title,
    status: row.status,
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    timeText: formatTime(row.updatedAt ?? "", Date.now()),
    pinned: row.pinned === true,
    archived: row.archived === true,
    // 宿主透传的未读标记：字段存在即未读（桌面侧栏蓝点用同一个值）。
    unread: row.unreadAt !== undefined,
    remote: row.session.workspaceIdentity !== undefined,
    offline: row.sourceAvailability === "offline",
    workspaceKey: key,
    workspaceLabel: workspaceLabel(row.session.workspacePath),
    // 上次看过之后又更新了，但还没回访过。
    unseen: lastOpened !== null && updatedAt > lastOpened.openedAt && row.session.sessionId !== lastOpened.sessionId,
    lastOpened: lastOpened !== null && row.session.sessionId === lastOpened.sessionId,
  };
}

/**
 * 目录的显示名：路径最后一段（兼容 Windows 分隔符）。
 * @param {string} path
 * @returns {string}
 */
export function workspaceLabel(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
