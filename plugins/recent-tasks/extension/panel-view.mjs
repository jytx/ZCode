// 面板页面的「视图」部分：DOM 渲染与事件分发。
//
// 构建时（scripts/build-panel.mjs）紧随 panel-core.mjs 内联进 ui/index.html。
// core 暴露状态、纯函数与宿主桥（window.__rt），这里负责把它们画出来，并把交互转回 core。
//
// 分成两个文件是为了各自不超过 300 行；core 不 import 这里，靠 setRender 交接渲染函数。
"use strict";
(() => {
  const rt = window.__rt;
  const { state, t, filterTasks } = rt;
  /** 取页面元素。 @param {string} id @returns {HTMLElement} */
  const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

  // ---------------------------------------------------------------- DOM 构造
  /** @param {string} tag @param {string} className @param {string | null} text @returns {HTMLElement} */
  function el(tag, className, text) {
    // 只用 textContent 写入内容，标题等来自任务数据也不需要转义。
    return Object.assign(document.createElement(tag), { className, textContent: text });
  }
  /** 一行的小标签：标题旁放状态，次要行放标记。 @param {import("./panel-core.mjs").Task} task */
  function taskTags(task) {
    /** @type {HTMLElement[]} */ const head = [];
    /** @type {HTMLElement[]} */ const meta = [];
    if (task.status === "running") head.push(el("span", "tag tag-info", t("running")));
    if (task.status === "needs_attention") head.push(el("span", "tag tag-warning", t("attention")));
    if (task.pinned) head.push(el("span", "tag", t("pinned")));
    if (task.unseen) meta.push(el("span", "tag tag-new", t("unseen")));
    if (task.lastOpened) meta.push(el("span", "tag", t("lastOpened")));
    if (task.remote) meta.push(el("span", "tag", t("remote")));
    if (task.offline) meta.push(el("span", "tag", t("offline")));
    if (task.timeText) meta.push(el("span", "", task.timeText));
    return { head, meta };
  }

  // ---------------------------------------------------------------- 渲染
  /** 渲染一行任务。 @param {import("./panel-core.mjs").Task} task @returns {HTMLLIElement} */
  function renderRow(task) {
    const row = el("li", "row", null);
    row.dataset.sessionId = task.sessionId;
    const tags = taskTags(task);
    const head = el("span", "row-head", null);
    // 未读蓝点：与桌面侧栏同一份未读标记（宿主 tasks-index 的 unreadAt）。
    // 放在标题前的固定槽位里，有无未读时标题的起始位置一致。
    const slot = el("span", "row-dot", null);
    if (task.unread) {
      const mark = el("span", "dot-unread", null);
      mark.title = t("unread");
      slot.appendChild(mark);
    }
    head.appendChild(slot);
    head.appendChild(el("span", "row-title", task.title || t("untitled")));
    for (const tag of tags.head) head.appendChild(tag);
    const meta = el("span", "row-meta", null);
    // 目录名放在次要行开头：跨项目时这是分辨「这条属于哪个项目」的唯一依据。
    if (task.workspaceLabel) meta.appendChild(el("span", "workspace", task.workspaceLabel));
    for (const tag of tags.meta) meta.appendChild(tag);
    row.append(head, meta);
    return row;
  }
  /** 渲染说明性状态块。 @param {string} title @param {string} [hint] */
  function renderState(title, hint) {
    const block = el("div", "state", null);
    block.appendChild(el("strong", "", title));
    if (hint) block.appendChild(el("span", "", hint));
    $("list").replaceChildren(block);
  }
  /** 提示条。 @param {import("./panel-core.mjs").Notice | null} notice */
  function renderNotice(notice) {
    $("notice").hidden = notice === null;
    $("notice-text").textContent = notice === null ? "" : t(notice.key, notice.values);
    $("notice-action").textContent = t(notice !== null && notice.key === "listFailed" ? "retry" : "grant");
    $("notice-action").hidden = notice === null || notice.grant !== true;
  }
  /**
   * 当前该显示的提示条：操作结果优先；没有操作结果时，列表订阅失败的原因也要说清楚
   * （未授权时用户要在这里看到「授权」按钮）。
   * @returns {import("./panel-core.mjs").Notice | null}
   */
  function currentNotice() {
    if (state.notice !== null) return state.notice;
    const list = state.model?.list;
    if (!list || list.phase !== "failed") return null;
    return list.errorCode === "not-granted"
      ? { key: "needGrant", grant: true }
      : { key: "listFailed", values: { code: list.errorCode ?? "" }, grant: true };
  }
  /** 全量重渲染。输入控件的值不在这里写，避免打断输入。 */
  function render() {
    const model = state.model;
    $("count").textContent = "";
    document.title = t("title");
    document.documentElement.lang = model?.locale?.startsWith("zh") ? "zh-CN" : "en";
    $("heading").textContent = t("title");
    $("search").placeholder = t("search");
    $("archived-label").textContent = t("showArchived");
    renderNotice(currentNotice());
    if (!model || (model.list.phase === "connecting" && model.counts.total === 0)) { renderState(t("connecting")); return; }
    // 订阅失败（未授权等）：原因和入口都在提示条里，列表区不再显示误导性的空态文案。
    if (model.list.phase === "failed") { $("list").replaceChildren(); return; }
    const tasks = filterTasks(model.flat);
    $("count").textContent = t("count", { n: String(tasks.length) }) + (model.truncated ? ` · ${t("truncated")}` : "");
    if (tasks.length === 0) {
      renderState(t(model.counts.total === 0 ? "emptyTitle" : "noMatch"), model.counts.total === 0 ? t("emptyHint") : undefined);
      return;
    }
    const list = el("ul", "", null);
    for (const task of tasks) list.appendChild(renderRow(task));
    $("list").replaceChildren(list);
  }

  // ---------------------------------------------------------------- 事件
  /** 列表区的点击：点一行就打开它。 @param {MouseEvent} event */
  async function onListClick(event) {
    const target = /** @type {HTMLElement} */ (event.target);
    const sessionId = target.closest("[data-session-id]")?.dataset.sessionId;
    if (sessionId) await rt.openTask(sessionId);
  }

  // ---------------------------------------------------------------- 启动
  /** 绑定控件与列表事件，然后启动宿主桥。 */
  function start() {
    $("search").addEventListener("input", () => { state.query = $("search").value; render(); });
    $("archived").addEventListener("change", () => { state.showArchived = $("archived").checked; render(); });
    $("notice-action").addEventListener("click", async () => {
      try {
        const data = await rt.call("requestGrant", {});
        if (!data.subscribed && (data.code || !data.allowed)) {
          state.notice = { key: data.code ? "grantFailed" : "grantDenied", values: { detail: data.message ?? data.code ?? "" } };
        }
        await rt.reload();
      } catch (error) {
        state.notice = { key: "grantFailed", values: { detail: String(error instanceof Error ? error.message : error) } };
        render();
      }
    });
    $("list").addEventListener("click", (event) => { void onListClick(event); });
    rt.setRender(render);
    void rt.boot();
  }
  start();
})();
