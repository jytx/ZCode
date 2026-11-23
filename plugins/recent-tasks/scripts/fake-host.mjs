// 扩展入口的冒烟测试用的假宿主：实现扩展用到的 ctx 成员，并把每次调用记下来供断言。
//
// 不依赖 ZCode 应用。列表订阅的 listener / onError 由测试用 emitSnapshot / emitDelta / failList 驱动；
// 视图实例由 openView / closeView 模拟面板的打开与关闭。
import assert from "node:assert/strict";
import { activate } from "../extension/index.mjs";

// ---------------------------------------------------------------------------
// 数据夹具
// ---------------------------------------------------------------------------

/**
 * 造一行任务。
 * @param {string} sessionId
 * @param {"idle" | "running" | "needs_attention"} status
 * @param {string} updatedAt ISO 时间
 * @param {number} [unreadAt] 未读标记（毫秒时间戳）；给出即未读，缺省即已读
 */
export const task = (sessionId, status, updatedAt, unreadAt) => ({
  session: { kind: "app", sourceServerId: "local", workspacePath: `/tmp/${sessionId}`, sessionId },
  title: `任务 ${sessionId}`,
  status,
  updatedAt,
  ...(unreadAt != null ? { unreadAt } : {}),
  archived: false,
  pinned: false,
  sourceAvailability: "online",
});

const T1 = "2026-11-23T09:00:00.000Z";
const T2 = "2026-11-23T10:00:00.000Z";
const T3 = "2026-11-23T11:00:00.000Z";
/** 三个状态各一行，更新时间故意与状态顺序相反。 */
export const ROW_RUNNING = task("a", "running", T2);
export const ROW_ATTENTION = task("b", "needs_attention", T3);
export const ROW_IDLE = task("c", "idle", T1);

// ---------------------------------------------------------------------------
// 假宿主
// ---------------------------------------------------------------------------

/**
 * 假宿主：实现扩展入口用到的 ctx 成员，并把每次调用记下来供断言。
 * @param {{openSession?: (input: {sessionId: string}) => Promise<object>, granted?: string[],
 *           locale?: string, dataPath?: string, readRows?: (input: {sessionId: string, limit: number}) => Promise<{rows: object[]}>}} options
 */
export function createFakeHost(options) {
  /** @type {Array<{itemId: string, patch: object, scope: string}>} */
  const slotUpdates = [];
  /** @type {string[]} */
  const openedViews = [];
  /** @type {string[]} */
  const openedSessions = [];
  /** @type {string[]} */
  const logs = [];
  /** 视图实例收到的通知 URI。 @type {string[]} */
  const notified = [];
  /** 当前有效的列表订阅：重新订阅后旧的必须被释放。 */
  const liveSubscriptions = new Set();
  /** @type {any} */
  let definition = null;
  let listListener = null;
  let listError = null;
  let listSubscriptions = 0;
  let envListener = null;
  let closeListener = null;
  let slotFails = false;

  const ctx = {
    extension: { id: "recent-tasks@smoke", dataPath: options.dataPath ?? "/tmp/recent-tasks-smoke" },
    log: {
      info: (message) => logs.push(`info ${message}`),
      warn: (message) => logs.push(`warn ${message}`),
    },
    slots: {
      update(itemId, patch, scope) {
        if (slotFails) throw Object.assign(new Error("boom"), { code: "invalid-input" });
        slotUpdates.push({ itemId, patch, scope });
      },
    },
    views: {
      register(id, next) {
        definition = { id, ...next };
      },
      async open(id) {
        openedViews.push(id);
      },
    },
    env: {
      async get() {
        return { locale: options.locale ?? "zh-CN" };
      },
      onDidChange(listener) {
        envListener = listener;
        return { dispose() {} };
      },
    },
    sessions: {
      onDidChangeList(listener, onError) {
        listSubscriptions += 1;
        listListener = listener;
        listError = onError ?? null;
        const token = Symbol("subscription");
        liveSubscriptions.add(token);
        return {
          dispose() {
            liveSubscriptions.delete(token);
          },
        };
      },
      async openSession(input) {
        openedSessions.push(input.sessionId);
        return options.openSession ? options.openSession(input) : { status: "opened" };
      },
      async setSessionPinned(input) {
        return { status: "applied", pinned: input.pinned };
      },
      async setSessionArchived(input) {
        return { status: "applied", archived: input.archived };
      },
      async renameSession(input) {
        return { status: "applied", title: input.title };
      },
      async readRows(input) {
        return options.readRows ? options.readRows(input) : { rows: [] };
      },
    },
    grants: {
      async request() {
        return { granted: options.granted ?? [] };
      },
    },
  };

  /** 宿主只在还有有效订阅时才投递事件。 */
  const deliver = (event) => {
    assert.ok(liveSubscriptions.size > 0, "没有有效的列表订阅");
    listListener(event);
  };

  return {
    ctx,
    slotUpdates,
    openedViews,
    openedSessions,
    logs,
    notified,
    get definition() {
      return definition;
    },
    get listSubscriptions() {
      return listSubscriptions;
    },
    get liveSubscriptions() {
      return liveSubscriptions.size;
    },
    /** 用户打开了面板。 */
    openView() {
      definition.onDidOpen({
        id: "view-1",
        notify: (uri) => notified.push(uri),
        onDidClose: (listener) => {
          closeListener = listener;
        },
      });
    },
    /** 用户关闭了面板。 */
    closeView() {
      closeListener();
    },
    /**
     * 等节流后的通知发出。
     * 扩展把连续的通知合并到一个固定间隔里才发一次（见 extension/index.mjs 的 NOTIFY_INTERVAL_MS），
     * 所以断言通知前要等一个间隔。
     * @param {number} [ms] 等待的毫秒数
     */
    async waitNotify(ms) {
      await new Promise((done) => setTimeout(done, ms ?? 400));
    },
    /** @param {object[]} sessions @param {boolean} [truncated] */
    emitSnapshot(sessions, truncated) {
      deliver({ kind: "snapshot", rev: 1, sessions, ...(truncated ? { truncated: true } : {}) });
    },
    /** @param {object[]} upserted @param {object[]} removed */
    emitDelta(upserted, removed) {
      deliver({ kind: "delta", rev: 2, upserted, removed });
    },
    /** @param {string} code */
    failList(code) {
      listError({ code, message: `${code} message` });
    },
    /** @param {string} locale */
    setLocale(locale) {
      envListener({ locale });
    },
    failSlotUpdates() {
      slotFails = true;
    },
    /** 读取视图模型资源：页面看到的就是这份 JSON。 */
    readModel() {
      const uri = Object.keys(definition.resources)[0];
      return JSON.parse(definition.resources[uri].read());
    },
    /** 调用视图工具。 @param {string} name @param {unknown} input */
    runTool(name, input) {
      return definition.tools[name].run(input, { view: null });
    },
  };
}

/**
 * 每个用例独立的宿主：创建并激活。
 * @param {Parameters<typeof createFakeHost>[0]} options
 */
export async function setup(options) {
  const host = createFakeHost(options);
  await activate(host.ctx);
  return host;
}

/** 激活后 env.get 的结果在微任务里到达；等它落地再断言语言相关的输出。 */
export const settle = () => new Promise((done) => queueMicrotask(done));
