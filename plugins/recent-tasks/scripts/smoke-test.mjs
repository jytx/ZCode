// 最近任务扩展的冒烟测试：用假宿主驱动扩展入口，不依赖 ZCode 应用。
//
// 覆盖：视图注册、列表合并、分组与展开规则、导航角标、打开任务、置顶归档改名、
// 预览读取、未授权到授权后的恢复、视图关闭后不再通知。
//
// 零依赖：只用 node:assert/strict。由 scripts/smoke-test.sh 调用，日志写入仓库 logs/。
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROW_ATTENTION, ROW_IDLE, ROW_RUNNING, settle, setup, task } from "./fake-host.mjs";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 视图模型里按时间平铺的任务 id。 @param {any} model @returns {string[]} */
const ids = (model) => model.flat.map((row) => row.sessionId);

/** @typedef {[string, () => Promise<void>]} Case */
/** @type {Case[]} */
const cases = [
  ["注册视图并在激活时订阅列表", async () => {
    const host = await setup({});
    assert.equal(host.definition.id, "recent-tasks");
    assert.equal(host.definition.entry, "./ui/index.html");
    await access(resolve(PLUGIN_ROOT, "ui/index.html")); // 产物必须存在
    assert.equal(host.listSubscriptions, 1);
    assert.deepEqual(host.readModel().flat, []);
    assert.deepEqual(host.readModel().list, { phase: "connecting", errorCode: null });
    assert.deepEqual(Object.keys(host.definition.tools).sort(), [
      "openTask", "requestGrant",
    ]);
  }],

  ["snapshot 整份替换并按更新时间降序，角标取待处理数", async () => {
    const host = await setup({});
    host.emitSnapshot([ROW_RUNNING, ROW_ATTENTION, ROW_IDLE]);
    const model = host.readModel();
    assert.deepEqual(ids(model), ["b", "a", "c"]);
    assert.equal(model.truncated, false);
    assert.deepEqual(model.list, { phase: "ready", errorCode: null });
    assert.deepEqual(model.counts, { total: 3, needsAttention: 1, running: 1, unseen: 0, unread: 0 });
    assert.deepEqual(host.slotUpdates.at(-1), {
      itemId: "open",
      patch: { badge: 1, tooltip: "1 个待处理，1 个运行中" },
      scope: "app",
    });
  }],

  ["未读标记透传：视图模型给出 unread 与计数", async () => {
    // 宿主行的 unreadAt 存在即未读（与桌面侧栏蓝点同一份数据）。
    const host = await setup({});
    host.emitSnapshot([
      task("u", "idle", "2026-11-23T09:00:00.000Z", 1764000000000),
      task("r", "idle", "2026-11-23T08:00:00.000Z"),
    ]);
    const model = host.readModel();
    assert.deepEqual(model.flat.map((row) => row.unread), [true, false]);
    assert.equal(model.counts.unread, 1);
    assert.deepEqual(host.slotUpdates.at(-1).patch, { badge: null, tooltip: "1 个未读" });
  }],

  ["delta 先增后删，旧快照不被改写", async () => {
    const host = await setup({});
    host.emitSnapshot([ROW_RUNNING, ROW_ATTENTION, ROW_IDLE]);
    const before = host.readModel();
    host.emitDelta([task("d", "needs_attention", "2026-11-23T12:00:00.000Z")], [ROW_RUNNING.session]);
    assert.deepEqual(ids(host.readModel()), ["d", "b", "c"]);
    assert.deepEqual(ids(before), ["b", "a", "c"]);
    assert.deepEqual(host.slotUpdates.at(-1).patch, { badge: 2, tooltip: "2 个待处理" });
  }],

  ["truncated：只有行数掉到上限以下才清除", async () => {
    const host = await setup({});
    const many = Array.from({ length: 1000 }, (_, index) => task(`s${index}`, "idle", "2026-11-23T09:00:00.000Z"));
    host.emitSnapshot(many, true);
    assert.equal(host.readModel().truncated, true);
    host.emitDelta([task("extra", "idle", "2026-11-23T09:00:00.000Z")], []);
    assert.equal(host.readModel().truncated, true); // 1001 行，仍在上限
    host.emitDelta([], [many[0].session, many[1].session]);
    assert.equal(host.readModel().truncated, false); // 999 行
  }],

  ["打开任务成功后重新聚焦面板", async () => {
    const host = await setup({});
    assert.deepEqual(await host.runTool("openTask", { sessionId: "sess_b" }), {
      ok: true,
      status: "opened",
      reason: null,
    });
    assert.deepEqual(host.openedSessions, ["sess_b"]);
    assert.deepEqual(host.openedViews, ["recent-tasks"]);
  }],

  ["打开任务不可用：如实返回原因，不重新聚焦", async () => {
    const host = await setup({
      openSession: async () => ({ status: "unavailable", reason: "navigation_unavailable" }),
    });
    assert.deepEqual(await host.runTool("openTask", { sessionId: "sess_x" }), {
      ok: false,
      status: "unavailable",
      reason: "navigation_unavailable",
    });
    assert.deepEqual(host.openedViews, []);
  }],

  ["打开任务被拒（例如远程工作区）：返回错误码，不重新聚焦", async () => {
    const forbidden = async () => {
      throw Object.assign(new Error("Session source does not match this Host"), { code: "forbidden" });
    };
    const host = await setup({ openSession: forbidden });
    assert.deepEqual(await host.runTool("openTask", { sessionId: "sess_remote" }), {
      ok: false,
      status: "error",
      code: "forbidden",
      message: "Session source does not match this Host",
    });
    assert.deepEqual(host.openedViews, []);
    assert.ok(host.logs.some((line) => line.includes("打开任务失败 forbidden")));
  }],

  ["打开任务入参非法：不调用宿主", async () => {
    const host = await setup({});
    for (const input of [{}, { sessionId: "" }, null, "sess_a"]) {
      assert.deepEqual(await host.runTool("openTask", input), { ok: false, status: "error", code: "invalid-input" });
    }
    assert.deepEqual(host.openedSessions, []);
  }],

  ["未授权时给出 not-granted，授权后重新订阅并恢复", async () => {
    const host = await setup({ granted: ["sessions.write"] });
    host.openView();
    host.failList("not-granted");
    assert.deepEqual(host.readModel().list, { phase: "failed", errorCode: "not-granted" });
    await host.waitNotify();
    assert.deepEqual(host.notified, ["ui://recent-tasks@smoke/state"], "订阅出错时要通知页面");

    assert.deepEqual(await host.runTool("requestGrant", {}), {
      granted: ["sessions.write"],
      allowed: true,
      subscribed: true,
    });
    assert.equal(host.listSubscriptions, 2);
    assert.equal(host.liveSubscriptions, 1, "同一时刻只有一个有效订阅");
    assert.equal(host.readModel().list.phase, "connecting");

    host.emitSnapshot([ROW_IDLE]);
    assert.equal(host.readModel().list.phase, "ready");
    // 已就绪时再点授权：不重复订阅。
    assert.deepEqual(await host.runTool("requestGrant", {}), { granted: ["sessions.write"], allowed: true, subscribed: false });
    assert.equal(host.listSubscriptions, 2);
  }],

  ["只授予读档位时不能恢复订阅", async () => {
    const host = await setup({ granted: ["sessions.read"] });
    host.failList("not-granted");
    assert.deepEqual(await host.runTool("requestGrant", {}), { granted: ["sessions.read"], allowed: false, subscribed: false });
    assert.equal(host.listSubscriptions, 1);
  }],

  ["视图关闭后不再通知", async () => {
    const host = await setup({});
    host.openView();
    host.emitSnapshot([ROW_IDLE]);
    await host.waitNotify();
    const sent = host.notified.length;
    host.closeView();
    host.emitDelta([], []);
    await host.waitNotify();
    assert.equal(host.notified.length, sent, "视图关闭后不再通知");
  }],

  ["面板打开时订阅已失败：自动重试，已授权则直接恢复", async () => {
    const host = await setup({});
    host.failList("not-granted");
    assert.equal(host.readModel().list.phase, "failed");
    host.openView(); // 用户在启动页授权之后打开面板
    assert.equal(host.listSubscriptions, 2, "打开面板会重新订阅一次");
    assert.equal(host.readModel().list.phase, "connecting");
    host.emitSnapshot([ROW_IDLE]);
    assert.equal(host.readModel().list.phase, "ready");
  }],

  ["面板打开时仍未授权：重试立刻失败，回到原来的提示", async () => {
    const host = await setup({});
    host.failList("not-granted");
    host.openView();
    host.failList("not-granted");
    assert.deepEqual(host.readModel().list, { phase: "failed", errorCode: "not-granted" });
    assert.equal(host.liveSubscriptions, 0);
  }],

  ["订阅正常或仍在等待时打开面板：不重复订阅", async () => {
    const host = await setup({});
    host.openView();
    assert.equal(host.listSubscriptions, 1, "等待首个事件时不重试");
    host.emitSnapshot([ROW_IDLE]);
    host.closeView();
    host.openView();
    assert.equal(host.listSubscriptions, 1, "已就绪时不重试");
  }],

  ["角标更新失败不影响列表", async () => {
    const host = await setup({});
    host.failSlotUpdates();
    host.emitSnapshot([ROW_ATTENTION]);
    assert.deepEqual(ids(host.readModel()), ["b"]);
    assert.ok(host.logs.some((line) => line.includes("更新导航角标失败 invalid-input")));
  }],

  ["悬停说明跟随界面语言", async () => {
    const host = await setup({ locale: "en-US" });
    await settle();
    host.emitSnapshot([ROW_RUNNING, ROW_ATTENTION]);
    assert.deepEqual(host.slotUpdates.at(-1).patch, { badge: 1, tooltip: "1 need attention, 1 running" });
    host.setLocale("zh-CN");
    assert.equal(host.slotUpdates.at(-1).patch.tooltip, "1 个待处理，1 个运行中");
    host.emitSnapshot([ROW_IDLE]);
    assert.deepEqual(host.slotUpdates.at(-1).patch, { badge: null, tooltip: "没有待处理或运行中的任务" });
  }],

];

let failed = 0;
for (const [name, run] of cases) {
  try {
    await run();
    console.log(`通过  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`失败  ${name}\n${error instanceof Error ? error.stack : String(error)}`);
  }
}
console.log(`\n共 ${cases.length} 项，${cases.length - failed} 项通过，${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
