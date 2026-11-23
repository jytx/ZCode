// 视图模型：把宿主的任务列表 + 记忆 + 界面语言，组装成页面直接可渲染的结构。
//
// 页面只做 DOM 渲染与事件分发，不做排序、统计和文案判断——那些都在这里做完。
// 这样页面脚本能压在单文件 300 行以内（沙箱只允许单文件 HTML，见 pluginSandbox/protocol.ts）。

import { countOf, sortForDisplay, toFlatTask, workspaceKey } from "./taskList.mjs";

/**
 * 相对时间的本地化格式化：分钟 / 小时 / 天，超过一个月退回月日。
 * 放在扩展侧算好，页面直接显示字符串——页面因此不必再实现一遍本地化逻辑。
 * @param {string | undefined} iso ISO 时间
 * @param {number} now 毫秒时间戳
 * @param {string} locale 界面语言
 * @param {(key: string) => string} translate 取文案
 * @returns {string}
 */
export function formatRelativeTime(iso, now, locale, translate) {
  const stamp = Date.parse(iso ?? "");
  if (!Number.isFinite(stamp)) return "";
  const tag = locale.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  const minutes = Math.round((now - stamp) / 60000);
  if (minutes < 1) return translate("justNow");
  const relative = (/** @type {number} */ value, /** @type {Intl.RelativeTimeFormatUnit} */ unit) =>
    new Intl.RelativeTimeFormat(tag, { numeric: "auto" }).format(-value, unit);
  if (minutes < 60) return relative(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative(hours, "hour");
  const days = Math.round(hours / 24);
  return days < 30
    ? relative(days, "day")
    : new Intl.DateTimeFormat(tag, { month: "numeric", day: "numeric" }).format(stamp);
}

/**
 * 页面拿到的视图模型。
 * @typedef {object} ViewModel
 * @property {Record<string, string>} strings 当前语言的文案
 * @property {string} locale 界面语言（页面用它做本地化的相对时间）
 * @property {import("./taskList.mjs").FlatTask[]} flat 按更新时间倒序的任务
 * @property {import("./taskList.mjs").ListState} list 列表订阅状态
 * @property {boolean} truncated
 * @property {{total: number, needsAttention: number, running: number, unseen: number, unread: number}} counts
 */

/**
 * 记忆的查询口：按工作区键取上次打开的任务。
 * @typedef {(key: string) => {sessionId: string, title: string, openedAt: number} | null} LastOpenedLookup
 */

/**
 * 构建视图模型。
 *
 * @param {object} input
 * @param {import("./taskList.mjs").TaskList} input.list 宿主任务列表
 * @param {import("./taskList.mjs").ListState} input.listState 列表订阅状态
 * @param {LastOpenedLookup} input.lookupLastOpened 查工作区上次打开的任务
 * @param {string} input.locale 界面语言
 * @returns {ViewModel}
 */
/**
 * 文案表。键与用途一一对应；值是两套语言，页面按 locale 取其中一套。
 * @type {Record<string, {zh: string, en: string}>}
 */
const TEXTS = {
  title: { zh: "最近任务", en: "Recent tasks" },
  search: { zh: "搜索标题", en: "Search titles" },
  showArchived: { zh: "显示已归档", en: "Show archived" },
  count: { zh: "{n} 个任务", en: "{n} tasks" },
  untitled: { zh: "未命名任务", en: "Untitled task" },
  pinned: { zh: "置顶", en: "Pinned" },
  remote: { zh: "远程", en: "Remote" },
  offline: { zh: "离线", en: "Offline" },
  unseen: { zh: "有新进展", en: "Updated" },
  unread: { zh: "未读", en: "Unread" },
  lastOpened: { zh: "上次看的", en: "Last opened" },
  running: { zh: "运行中", en: "Running" },
  attention: { zh: "待处理", en: "Needs attention" },
  justNow: { zh: "刚刚", en: "just now" },
  connecting: { zh: "正在读取任务列表…", en: "Loading tasks…" },
  emptyTitle: { zh: "没有任务", en: "No tasks" },
  emptyHint: { zh: "新任务会自动出现在这里。", en: "New tasks show up here automatically." },
  noMatch: { zh: "没有匹配的任务", en: "No matching tasks" },
  truncated: { zh: "任务较多，只列出最近的一部分。", en: "Showing only the most recent tasks." },
  needGrant: { zh: "需要授权后才能读取任务列表，并从中跳转到任务。", en: "Authorization is needed to read the task list and jump to tasks." },
  grant: { zh: "授权", en: "Authorize" },
  listFailed: { zh: "任务列表暂时读不到（{code}）。", en: "The task list is unavailable right now ({code})." },
  retry: { zh: "重试", en: "Retry" },
  grantDenied: { zh: "没有完成授权，任务列表仍不可用。", en: "Authorization was not completed; the task list is still unavailable." },
  grantFailed: { zh: "授权请求没有成功（{detail}）。", en: "The authorization request failed ({detail})." },
  openForbidden: { zh: "远程工作区的任务暂时不能从这里打开。", en: "Tasks in remote workspaces cannot be opened from here yet." },
  openUnavailable: { zh: "没能打开这个任务（{detail}）。", en: "Couldn't open this task ({detail})." },
  openFailed: { zh: "打开失败：{detail}", en: "Failed to open: {detail}" },
  bridgeFailed: { zh: "面板没有连上宿主：{detail}", en: "The panel could not reach the host: {detail}" },
  staleExtension: {
    zh: "扩展代码还是旧版本，请重启 ZCode 后再打开本面板。",
    en: "The extension is still running an old version. Restart ZCode and reopen this panel.",
  },
  noStateResource: {
    zh: "没有找到任务列表数据，请重启 ZCode 后再打开本面板。",
    en: "The task list data was not found. Restart ZCode and reopen this panel.",
  },
  archived: { zh: "已归档", en: "Archived" },
  pinned2: { zh: "已置顶", en: "Pinned" },
};

/**
 * 取当前语言的文案表（页面拿到的是扁平字符串，不再自己判断语言）。
 * @param {string} locale 宿主界面语言
 * @returns {Record<string, string>}
 */
export function buildStrings(locale) {
  const zh = locale.toLowerCase().startsWith("zh");
  /** @type {Record<string, string>} */
  const strings = {};
  for (const [key, value] of Object.entries(TEXTS)) strings[key] = zh ? value.zh : value.en;
  return strings;
}

/**
 * 构建视图模型。
 *
 * @param {object} input
 * @param {import("./taskList.mjs").TaskList} input.list 宿主任务列表
 * @param {import("./taskList.mjs").ListState} input.listState 列表订阅状态
 * @param {LastOpenedLookup} input.lookupLastOpened 查工作区上次打开的任务
 * @param {string} input.locale 界面语言
 * @returns {ViewModel}
 */
export function buildViewModel(input) {
  const rows = sortForDisplay([...input.list.rows.values()]);
  const strings = buildStrings(input.locale);
  const translate = (/** @type {string} */ key) => strings[key] ?? key;
  const flat = rows.map((row) => toFlatTask(row, input.lookupLastOpened, (iso, now) =>
    formatRelativeTime(iso, now, input.locale, translate),
  ));
  return {
    strings,
    locale: input.locale,
    flat,
    list: input.listState,
    truncated: input.list.truncated,
    counts: {
      total: flat.length,
      needsAttention: countOf(rows, "needs_attention"),
      running: countOf(rows, "running"),
      unseen: flat.filter((task) => task.unseen).length,
      unread: flat.filter((task) => task.unread).length,
    },
  };
}

export { workspaceKey };
