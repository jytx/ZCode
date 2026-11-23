// 面板页面冒烟测试用的桩：最小 DOM、页面视角的宿主桥（window.zcode）与视图模型夹具。
//
// 只实现页面脚本用到的成员，不负责样式与布局。所以「hidden 属性是否真的让元素不可见」这类
// 依赖浏览器渲染的问题在这里测不出来，由 page-smoke.mjs 里的源码守卫兜底。
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInThisContext, Script } from "node:vm";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 页面模板：样式守卫用例要读 <style>。 */
export const PAGE_TEMPLATE = readFileSync(resolve(PLUGIN_ROOT, "ui/panel.template.html"), "utf8");
/**
 * 页面脚本：core 与 view 两段，按顺序执行（core 先定义 window.__rt）。
 * 与构建产物内联的顺序一致。
 */
const PAGE_SCRIPTS = ["extension/panel-core.mjs", "extension/panel-view.mjs"].map((file) =>
  readFileSync(resolve(PLUGIN_ROOT, file), "utf8"),
);
for (const [index, source] of PAGE_SCRIPTS.entries()) {
  new Script(source, { filename: `panel-${index}.mjs` });
}
/** 视图模型资源的 URI。 */
export const TASKS_URI = "ui://recent-tasks@smoke/state";
/** 页面里带 id 的元素。 */
const PAGE_IDS = ["heading", "search", "archived", "archived-label", "count", "mode", "notice", "notice-text", "notice-action", "list"];

// ---------------------------------------------------------------------------
// 桩
// ---------------------------------------------------------------------------

/**
 * 最小 DOM 桩：只实现页面脚本用到的成员。textContent 取自身文字与子节点文字的拼接。
 * @param {string[]} ids
 */
function createDocument(ids) {
  const createElement = (tagName) => {
    const element = {
      tagName: String(tagName).toUpperCase(), className: "", text: "", children: [], parentNode: null,
      attrs: {}, dataset: {}, hidden: false, tabIndex: -1, title: "", lang: "", placeholder: "", checked: false, value: "",
      style: { values: {}, setProperty(name, value) { this.values[name] = value; } },
      /** @type {Map<string, Array<(event: object) => void>>} */ listeners: new Map(),
      classList: {
        add(name) {
          if (!element.className.split(/\s+/).includes(name)) element.className = `${element.className} ${name}`.trim();
        },
      },
      appendChild(child) {
        child.parentNode = element;
        element.children.push(child);
        return child;
      },
      append(...nodes) {
        for (const node of nodes) element.appendChild(node);
      },
      replaceChildren(...nodes) {
        element.children = [];
        element.append(...nodes);
      },
      setAttribute(name, value) {
        element.attrs[name] = String(value);
      },
      addEventListener(type, listener) {
        element.listeners.set(type, [...(element.listeners.get(type) ?? []), listener]);
      },
      /**
       * 触发事件：像真实 DOM 一样沿祖先链冒泡，event.target 始终是最初触发的元素。
       * @param {string} type 事件类型
       * @param {object} [extra] 追加到事件对象上的字段（例如键盘事件的 key）
       */
      dispatch(type, extra) {
        const event = { target: element, preventDefault() {}, stopPropagation() {}, ...extra };
        let node = element;
        while (node) {
          for (const listener of node.listeners.get(type) ?? []) listener(event);
          node = node.parentNode;
        }
      },
      /** 事件从子元素冒泡到祖先：closest 依赖这条链。 @param {string} selector @returns {any} */
      closest(selector) {
        // 选择器形如 [data-group]、[data-session-id]：dataset 的键是驼峰形式（group、sessionId）。
        const attribute = selector.startsWith("[") ? selector.slice(1, -1) : null;
        const key = attribute
          ? attribute.replace(/^data-/, "").replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
          : null;
        let node = element;
        while (node) {
          if (key && node.dataset?.[key] !== undefined) return node;
          node = node.parentNode;
        }
        return null;
      },
      get textContent() {
        return element.text + element.children.map((child) => child.textContent).join("");
      },
      set textContent(value) {
        element.children = [];
        element.text = value === null ? "" : String(value);
      },
    };
    return element;
  };
  const byId = new Map(ids.map((id) => [id, createElement("div")]));
  return {
    title: "",
    documentElement: createElement("html"),
    getElementById: (id) => byId.get(id) ?? null,
    createElement,
    createTextNode: (text) => ({ textContent: String(text) }),
  };
}

/**
 * 页面视角的宿主桥（window.zcode）：记录调用，按 options.tools 返回工具结果。
 * @param {{model: object, tools: Record<string, (args: object) => object>, locale?: string,
 *           resources?: string[]}} options
 *   resources 缺省为页面资源与视图模型资源；可传旧版资源列表来模拟「扩展进程还是旧版本」。
 */
function createPageHost(options) {
  /** @type {Array<[string, unknown]>} */
  const calls = [];
  /** @type {Array<(uri: string) => void>} */
  const updated = [];
  let model = options.model;
  const api = {
    theme: "light",
    locale: options.locale ?? "zh-CN",
    hostContext: { styles: { variables: { "--color-foreground": "#123456" } } },
    ready: async () => {},
    subscribe: () => () => {},
    listResources: async () => ({
      resources: (options.resources ?? ["ui://x/page", TASKS_URI]).map((uri) => ({ uri })),
    }),
    readResource: async (uri) => {
      calls.push(["readResource", uri]);
      return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(model) }] };
    },
    subscribeResource: async (uri) => {
      calls.push(["subscribeResource", uri]);
    },
    onResourceUpdated: (listener) => {
      updated.push(listener);
      return () => {};
    },
    callTool: async (name, args) => {
      calls.push(["callTool", name, args]);
      return { content: [], structuredContent: options.tools[name](args) };
    },
  };
  return {
    api,
    calls,
    setModel(next) {
      model = next;
    },
    notify(uri) {
      for (const listener of updated) listener(uri);
    },
  };
}

/** 等 boot 的异步链跑完（宏任务边界）。 */
export const settle = () => new Promise((done) => setImmediate(done));
/**
 * 等节流后的重读完成。
 * 页面把密集的变更通知合并到一个固定间隔里才重读（见 extension/panel-core.mjs 的 RELOAD_INTERVAL_MS），
 * 所以断言重读结果前要等一个间隔。
 * @param {number} [ms] 等待的毫秒数
 */
export const waitReload = (ms) => new Promise((done) => setTimeout(done, ms ?? 300));

// ---------------------------------------------------------------------------
// 视图模型夹具
// ---------------------------------------------------------------------------

/**
 * 任务行的夹具（与扩展侧视图模型的行同形）。
 * @param {string} sessionId @param {string} title @param {string} status @param {object} [extra]
 */
export const row = (sessionId, title, status, extra) => ({
  sessionId,
  title,
  status,
  timeText: "1 分钟前",
  pinned: false,
  archived: false,
  unread: false,
  remote: false,
  offline: false,
  unseen: false,
  lastOpened: false,
  workspaceLabel: "proj",
  ...extra,
});

/**
 * 视图模型夹具：平铺的任务列表 + 文案 + 统计。
 * @param {object} [options]
 */
export const model = (options) => {
  const flat = options?.flat ?? [row("a", "修登录 bug", "running"), row("b", "写周报", "needs_attention")];
  return {
    strings: options?.strings ?? {
      title: "最近任务", search: "搜索标题", showArchived: "显示已归档", groupByProject: "按项目", groupByTime: "按时间",
      count: "{n} 个任务", groupCount: "{n} 个", untitled: "未命名任务", pinned: "置顶", remote: "远程", offline: "离线",
      unseen: "有新进展", unread: "未读", lastOpened: "上次看的", running: "运行中", attention: "待处理", opening: "正在打开…", justNow: "刚刚",
      connecting: "正在读取任务列表…", emptyTitle: "没有任务", emptyHint: "新任务会自动出现在这里。", noMatch: "没有匹配的任务",
      truncated: "任务较多，只列出最近的一部分。", needGrant: "需要授权后才能读取任务列表，并从中跳转到任务。", grant: "授权",
      listFailed: "任务列表暂时读不到（{code}）。", retry: "重试", grantDenied: "没有完成授权，任务列表仍不可用。",
      grantFailed: "授权请求没有成功（{detail}）。", openForbidden: "远程工作区的任务暂时不能从这里打开。",
      openUnavailable: "没能打开这个任务（{detail}）。", openFailed: "打开失败：{detail}", bridgeFailed: "面板没有连上宿主：{detail}",
      preview: "预览", previewLoading: "正在读取…", previewFailed: "读不到内容（{detail}）", previewEmpty: "这个任务还没有内容。",
      previewOpen: "打开", roleUser: "我", roleAssistant: "助手", roleSystem: "系统", roleTool: "工具",
      actionPin: "置顶", actionUnpin: "取消置顶", actionArchive: "归档", actionUnarchive: "取消归档", actionRename: "改名",
    },
    locale: options?.locale ?? "zh-CN",
    flat,
    list: options?.list ?? { phase: "ready", errorCode: null },
    truncated: false,
    counts: options?.counts ?? { total: flat.length, needsAttention: 1, running: 1, unseen: 0, unread: 0 },
  };
};
/** 列表订阅因未授权而结束。 */
export const denied = { phase: "failed", errorCode: "not-granted" };

// ---------------------------------------------------------------------------
// 挂载与查询辅助
// ---------------------------------------------------------------------------

/**
 * 挂载页面：装好全局桩、执行页面脚本、等首次加载完成。
 * @param {Parameters<typeof createPageHost>[0]} options
 */
export async function mount(options) {
  const page = createPageHost(options);
  globalThis.window = { zcode: page.api };
  globalThis.document = createDocument(PAGE_IDS);
  for (const source of PAGE_SCRIPTS) runInThisContext(source, { filename: "panel.mjs" });
  await settle();
  return { page, doc: /** @type {any} */ (globalThis.document) };
}
/** @param {any} doc @param {string} id */
export const element = (doc, id) => doc.getElementById(id);
/** 平铺列表里各行的标题。 @param {any} doc @returns {string[]} */
export const titles = (doc) => {
  const list = element(doc, "list").children[0];
  if (!list || list.tagName !== "UL") return [];
  return list.children.map((item) => {
    // 标题行的第一个子元素是未读槽位，标题在它后面；按类名取，避免依赖下标。
    const head = item.children[0];
    const title = head.children.find((child) => child.className === "row-title");
    return title ? title.textContent : "";
  });
};
/** 某一行有没有未读蓝点。 @param {any} doc @param {number} index @returns {boolean} */
export const hasUnreadDot = (doc, index) => {
  // 标题行的第一个子元素是未读槽位，蓝点画在槽位里（没有蓝点时槽位是空的）。
  const slot = element(doc, "list").children[0].children[index].children[0].children[0];
  return slot.children.some((child) => child.className === "dot-unread");
};
/** 提示条当前显示的文字；整条隐藏时为 null。 @param {any} doc */
export const noticeText = (doc) => (element(doc, "notice").hidden ? null : element(doc, "notice-text").textContent);
/** @param {{calls: Array<[string, unknown]>}} page @param {string} name */
export const toolCalls = (page, name) => page.calls.filter(([kind, target]) => kind === "callTool" && target === name);
