// 面板页面的「核心」部分：状态、纯函数与宿主桥。
//
// 构建时（scripts/build-panel.mjs）与 panel-view.mjs 一起按顺序内联进 ui/index.html。
// 与 view 分成两个文件是为了各自不超过 300 行：core 管状态与对外调用，view 管 DOM 渲染与事件分发；
// 两块通过 window.__rt 交接，view 用 setRender 注册渲染函数，core 的操作完成后借此重绘。
//
// 约定：这里不写业务逻辑——排序、统计、相对时间与文案都由扩展进程算好（见 viewModel.mjs），
// 页面只做 DOM 渲染与事件分发；所有可见文案都取自视图模型的 strings，页面不维护第二份文案表。
"use strict";
(() => {
  // ---------------------------------------------------------------- 类型
  /** @typedef {{sessionId: string, title: string, status: string, timeText: string, pinned: boolean, archived: boolean, unread: boolean, remote: boolean, offline: boolean, workspaceLabel: string, unseen: boolean, lastOpened: boolean}} Task */
  /** @typedef {{strings: Record<string, string>, locale: string, flat: Task[], list: {phase: string, errorCode: string | null}, truncated: boolean, counts: {total: number, needsAttention: number, unseen: number}}} ViewModel */
  /** @typedef {{key: string, values?: Record<string, string>, grant?: boolean}} Notice */

  // ---------------------------------------------------------------- 状态（唯一来源；渲染只读它）
  const state = {
    /** @type {ViewModel | null} */ model: null,
    query: "", showArchived: false,
    /** @type {Notice | null} */ notice: null,
  };
  /** 视图模型资源的 URI，握手后从 resources/list 里找出来。 @type {string | null} */ let stateUri = null;
  /** 变更通知的合并间隔（毫秒）：密集通知时只重读一次。 */
  const RELOAD_INTERVAL_MS = 150;

  // ---------------------------------------------------------------- 纯函数
  /**
   * 兜底文案：视图模型还没读到时（例如扩展进程是旧版本），界面也要能显示中文，
   * 而不是一串英文键名。完整文案由扩展进程的视图模型给出，这里只覆盖界面骨架。
   */
  const FALLBACK_STRINGS = {
    zh: {
      title: "最近任务", search: "搜索标题", showArchived: "显示已归档", count: "{n} 个任务",
      untitled: "未命名任务", running: "运行中", attention: "待处理", connecting: "正在读取任务列表…",
      emptyTitle: "没有任务", emptyHint: "新任务会自动出现在这里。", noMatch: "没有匹配的任务",
      needGrant: "需要授权后才能读取任务列表。", grant: "授权", listFailed: "任务列表暂时读不到（{code}）。",
      retry: "重试", staleExtension: "扩展代码还是旧版本，请重启 ZCode 后再打开本面板。",
      noStateResource: "没有找到任务列表数据，请重启 ZCode 后再打开本面板。", bridgeFailed: "面板没有连上宿主：{detail}",
      unread: "未读",
    },
    en: {
      title: "Recent tasks", search: "Search titles", showArchived: "Show archived", count: "{n} tasks",
      untitled: "Untitled task", running: "Running", attention: "Needs attention", connecting: "Loading tasks…",
      emptyTitle: "No tasks", emptyHint: "New tasks show up here automatically.", noMatch: "No matching tasks",
      needGrant: "Authorization is needed to read the task list.", grant: "Authorize",
      listFailed: "The task list is unavailable right now ({code}).", retry: "Retry",
      staleExtension: "The extension is still running an old version. Restart ZCode and reopen this panel.",
      noStateResource: "The task list data was not found. Restart ZCode and reopen this panel.",
      bridgeFailed: "The panel could not reach the host: {detail}",
      unread: "Unread",
    },
  };

  /** 界面语言归一：locale 以 "zh" 开头用中文，否则英文。 @param {string | null | undefined} raw @returns {"zh" | "en"} */
  function normalizeLocale(raw) { return typeof raw === "string" && raw.toLowerCase().startsWith("zh") ? "zh" : "en"; }
  /** 文案模板：{name} 换成 values 里的值。优先用视图模型的文案，其次兜底文案，最后退回键名。 @param {string} key @param {Record<string, string>} [values] @returns {string} */
  function t(key, values) {
    // 视图模型还没读到时（扩展进程是旧版本），语言以宿主桥给的为准，兜底文案才有正确的语言。
    const locale = state.model?.locale ?? window.zcode?.locale;
    const strings = state.model?.strings ?? FALLBACK_STRINGS[normalizeLocale(locale)];
    const template = strings[key] ?? key;
    return values ? template.replace(/\{(\w+)\}/g, (_match, name) => values[name] ?? "") : template;
  }
  /** 过滤：默认隐藏已归档；关键字匹配标题。 @param {Task[]} tasks @returns {Task[]} */
  function filterTasks(tasks) {
    const keyword = state.query.trim().toLowerCase();
    return tasks.filter((task) => (state.showArchived || !task.archived)
      && (keyword === "" || task.title.toLowerCase().includes(keyword)));
  }
  /** 工具结果里的结构化数据；工具报错（isError）时为 null。 @param {{isError?: boolean, structuredContent?: unknown}} result */
  function readData(result) { return result.isError === true ? null : /** @type {any} */ (result.structuredContent ?? null); }

  // ---------------------------------------------------------------- 宿主桥
  /** 跟随宿主：主题变量、明暗。宿主每次状态变化都会回调。 */
  function applyHost() {
    const host = window.zcode;
    const variables = host.hostContext?.styles?.variables ?? {};
    for (const [name, value] of Object.entries(variables)) {
      if (typeof value === "string") document.documentElement.style.setProperty(name, value);
    }
    document.documentElement.dataset.theme = host.theme === "dark" ? "dark" : "light";
    renderFn();
  }
  /** 调一个工具；失败抛出，由调用方给出提示。 @param {string} name @param {object} args @returns {Promise<any>} */
  async function call(name, args) {
    const data = readData(await window.zcode.callTool(name, args));
    if (data === null) throw new Error("isError");
    return data;
  }
  /** 重新读取视图模型。 @returns {Promise<void>} */
  async function reload() {
    try {
      const result = await window.zcode.readResource(/** @type {string} */ (stateUri));
      state.model = JSON.parse(result.contents[0].text);
    } catch (error) {
      state.notice = { key: "bridgeFailed", values: { detail: String(error instanceof Error ? error.message : error) } };
    }
    renderFn();
  }
  /**
   * 收到变更通知后的重读：合并短时间内的多次通知。
   * 宿主任务投影在流式输出时高频变化，逐次重读会让页面反复整份重建。
   */
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reloadTimer = null;
  const scheduleReload = () => {
    if (reloadTimer !== null) return;
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      void reload();
    }, RELOAD_INTERVAL_MS);
  };
  /** 打开任务：让主窗口切到它所在的工作区并选中它。 @param {string} sessionId @returns {Promise<void>} */
  async function openTask(sessionId) {
    try {
      const data = await call("openTask", { sessionId });
      if (data.ok) state.notice = null;
      else if (data.code === "not-granted") state.notice = { key: "needGrant", grant: true };
      else if (data.code === "forbidden") state.notice = { key: "openForbidden" };
      else state.notice = { key: data.status === "unavailable" ? "openUnavailable" : "openFailed",
        values: { detail: data.message ?? data.reason ?? data.code ?? "" } };
    } catch (error) {
      state.notice = { key: "openFailed", values: { detail: String(error instanceof Error ? error.message : error) } };
    }
    renderFn();
  }

  // ---------------------------------------------------------------- 启动
  /** 入口：等宿主握手 → 找到视图模型资源并订阅 → 首次读取。控件事件由 view 绑定。 */
  async function boot() {
    renderFn(); // 桥就绪前先渲染默认文案，避免闪空白
    if (!window.zcode) { state.notice = { key: "bridgeFailed", values: { detail: "window.zcode" } }; renderFn(); return; }
    try {
      await window.zcode.ready();
      window.zcode.subscribe(applyHost);
      applyHost();
      const resources = await window.zcode.listResources();
      const uris = resources.resources.map((resource) => resource.uri);
      stateUri = uris.find((uri) => uri.endsWith("/state")) ?? null;
      if (stateUri === null) {
        // 扩展进程加载入口用的是 import()，命中 Node 的 ESM 模块缓存就不会重新读文件，
        // 于是仍在跑旧版本：资源是 /tasks 而不是 /state。这种情况要明确告诉用户重启，
        // 否则只会看到一句「面板没有连上宿主」，无从判断原因。
        const stale = uris.some((uri) => uri.endsWith("/tasks"));
        state.notice = { key: stale ? "staleExtension" : "noStateResource" };
        renderFn();
        return;
      }
      await window.zcode.subscribeResource(stateUri);
      window.zcode.onResourceUpdated((uri) => { if (uri === stateUri) scheduleReload(); });
      await reload();
    } catch (error) {
      state.notice = { key: "bridgeFailed", values: { detail: String(error instanceof Error ? error.message : error) } };
      renderFn();
    }
  }

  /** 渲染函数由 view 注册：core 的操作完成后要重绘，但渲染实现住在 view 里。 @type {() => void} */
  let renderFn = () => {};
  window.__rt = {
    state, t, filterTasks, readData, boot,
    call, openTask, reload,
    /** @param {() => void} fn */
    setRender(fn) { renderFn = fn; },
  };
})();
