// 最近任务面板页面的冒烟测试：用最小 DOM 桩在 Node 里驱动页面脚本。
//
// 覆盖：平铺渲染与目录名、搜索过滤、空态、未授权提示、预览展开、行内操作、改名。
// 只验证页面逻辑与它对宿主桥的调用。
//
// 零依赖：node:assert/strict。桩在 page-fake-host.mjs，由 scripts/smoke-test.sh 调用。
import assert from "node:assert/strict";
import {
  PAGE_TEMPLATE,
  TASKS_URI,
  denied,
  element,
  hasUnreadDot,
  model,
  mount,
  noticeText,
  row,
  settle,
  titles,
  toolCalls,
  waitReload,
} from "./page-fake-host.mjs";

const OK = { ok: true, status: "opened", reason: null };
const FORBIDDEN = { ok: false, status: "error", code: "forbidden", message: "nope" };
const GRANTED = { granted: ["sessions.write"], allowed: true, subscribed: false };
/** 空列表的视图模型：列表订阅失败或没有任务时用。 */
const emptyModel = (options) =>
  model({ flat: [], list: options?.list, counts: { total: 0, needsAttention: 0, running: 0, unseen: 0, unread: 0 } });

/** 取列表里的第 n 行。 @param {any} doc @param {number} index */
const rowAt = (doc, index) => element(doc, "list").children[0].children[index];

/** @typedef {[string, () => Promise<void>]} Case */
/** @type {Case[]} */
const cases = [
  ["握手后读取并订阅视图模型，按时间平铺渲染任务行", async () => {
    const { page, doc } = await mount({ model: model(), tools: {} });
    assert.deepEqual(page.calls.filter(([kind]) => kind !== "callTool"), [
      ["subscribeResource", TASKS_URI],
      ["readResource", TASKS_URI],
    ]);
    assert.deepEqual(titles(doc), ["修登录 bug", "写周报"]);
    assert.equal(element(doc, "count").textContent, "2 个任务");
    assert.equal(element(doc, "heading").textContent, "最近任务");
    assert.equal(rowAt(doc, 0).children[0].children[2].textContent, "运行中");
    assert.equal(rowAt(doc, 1).children[0].children[2].textContent, "待处理");
    assert.equal(noticeText(doc), null);
  }],

  ["未读任务在标题前标出蓝点，已读的不标", async () => {
    const { doc } = await mount({
      model: model({
        flat: [
          row("a", "修登录 bug", "idle", { unread: true }),
          row("b", "写周报", "idle", { unread: false }),
        ],
      }),
      tools: {},
    });
    assert.equal(hasUnreadDot(doc, 0), true, "未读的行要有蓝点");
    assert.equal(hasUnreadDot(doc, 1), false, "已读的行不标蓝点");
    // 槽位固定宽度：有无蓝点时标题的起始位置一致。
    assert.equal(rowAt(doc, 0).children[0].children[0].className, "row-dot");
    assert.equal(rowAt(doc, 1).children[0].children[0].className, "row-dot");
  }],

  ["每行显示所属工作区的目录名", async () => {
    const { doc } = await mount({
      model: model({
        flat: [
          row("a", "修登录 bug", "idle", { workspaceLabel: "shop-api" }),
          row("b", "写周报", "idle", { workspaceLabel: "web-console" }),
        ],
      }),
      tools: {},
    });
    assert.equal(rowAt(doc, 0).children[1].children[0].textContent, "shop-api");
    assert.equal(rowAt(doc, 1).children[1].children[0].textContent, "web-console");
  }],

  ["未授权：提示条显示授权入口，列表区不显示误导性空态", async () => {
    const { doc } = await mount({ model: emptyModel({ list: denied }), tools: {} });
    assert.equal(noticeText(doc), "需要授权后才能读取任务列表，并从中跳转到任务。");
    assert.equal(element(doc, "notice-action").hidden, false);
    assert.equal(element(doc, "notice-action").textContent, "授权");
    assert.equal(element(doc, "list").children.length, 0);
    assert.equal(element(doc, "count").textContent, "");
  }],

  ["点授权：调用 requestGrant，列表恢复后重渲染", async () => {
    const { page, doc } = await mount({
      model: emptyModel({ list: denied }),
      tools: { requestGrant: () => ({ granted: ["sessions.write"], allowed: true, subscribed: true }) },
    });
    element(doc, "notice-action").dispatch("click");
    page.setModel(model());
    await settle();
    assert.deepEqual(toolCalls(page, "requestGrant"), [["callTool", "requestGrant", {}]]);
    assert.deepEqual(titles(doc), ["修登录 bug", "写周报"]);
    assert.equal(noticeText(doc), null);
  }],

  ["用户取消授权：给出说明，仍可再次授权", async () => {
    const { doc } = await mount({
      model: emptyModel({ list: denied }),
      tools: { requestGrant: () => ({ granted: [], allowed: false, subscribed: false }) },
    });
    element(doc, "notice-action").dispatch("click");
    await settle();
    assert.equal(noticeText(doc), "没有完成授权，任务列表仍不可用。");
  }],

  ["列表正常时再点授权：不报错，提示条保持隐藏", async () => {
    // 回归：用户已授权、列表正常时再点「授权」，旧代码会报
    // 「授权请求没有成功（Cannot read properties of undefined (reading 'replace')）」。
    const { page, doc } = await mount({ model: model(), tools: { requestGrant: () => GRANTED } });
    assert.equal(noticeText(doc), null);
    element(doc, "notice-action").dispatch("click");
    await settle();
    assert.deepEqual(toolCalls(page, "requestGrant"), [["callTool", "requestGrant", {}]]);
    assert.equal(noticeText(doc), null, "不能再出现授权失败的提示");
    assert.equal(element(doc, "notice").hidden, true);
    assert.equal(element(doc, "notice-action").hidden, true);
  }],

  ["提示条隐藏后不残留上一次的文案和按钮", async () => {
    const { page, doc } = await mount({
      model: emptyModel({ list: denied }),
      tools: { requestGrant: () => ({ granted: ["sessions.write"], allowed: true, subscribed: true }) },
    });
    assert.equal(element(doc, "notice-action").textContent, "授权");
    page.setModel(model());
    element(doc, "notice-action").dispatch("click");
    page.notify(TASKS_URI);
    await waitReload();
    assert.equal(element(doc, "notice").hidden, true);
    assert.equal(element(doc, "notice-text").textContent, "");
    assert.equal(element(doc, "notice-action").hidden, true);
  }],

  ["样式守卫：给提示条设置 display 的规则不得盖过 hidden 属性", async () => {
    // DOM 桩不渲染，测不出「hidden 了却仍然可见」。作者样式里的 display 优先级高于 hidden 自带的
    // 隐藏效果，所以这类规则必须带上 [hidden] 条件。取选择器前先去掉注释：注释里出现 [hidden]
    // 字样不算数，否则守卫会被自己的说明文字骗过去。
    const css = PAGE_TEMPLATE.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body]);
    const noticed = rules.filter(([selector, body]) => /#notice\b/.test(selector) && /\bdisplay\s*:/.test(body));
    assert.equal(noticed.length, 1, "守卫应当恰好检查到提示条的 display 规则，否则是守卫本身失效了");
    for (const [selector] of noticed) {
      assert.match(selector, /\[hidden\]/, `这条规则会让隐藏的提示条仍然可见：${selector}`);
    }
  }],

  ["搜索过滤标题，隐藏已归档任务", async () => {
    const flat = [row("a", "修登录 bug", "idle"), { ...row("b", "旧任务", "idle"), archived: true }];
    const { doc } = await mount({ model: model({ flat }), tools: {} });
    assert.deepEqual(titles(doc), ["修登录 bug"]);
    element(doc, "search").value = "旧任务";
    element(doc, "search").dispatch("input");
    assert.deepEqual(titles(doc), [], "默认隐藏已归档任务");
    element(doc, "archived").checked = true;
    element(doc, "archived").dispatch("change");
    assert.deepEqual(titles(doc), ["旧任务"]);
    element(doc, "search").value = "";
    element(doc, "search").dispatch("input");
    assert.deepEqual(titles(doc), ["修登录 bug", "旧任务"]);
  }],

  ["点一行就打开它", async () => {
    const { page, doc } = await mount({ model: model(), tools: { openTask: () => OK } });
    rowAt(doc, 1).dispatch("click");
    await settle();
    assert.deepEqual(toolCalls(page, "openTask"), [["callTool", "openTask", { sessionId: "b" }]]);
    assert.equal(noticeText(doc), null);
  }],

  ["打开被拒：提示原因", async () => {
    const { doc } = await mount({ model: model(), tools: { openTask: () => FORBIDDEN } });
    rowAt(doc, 0).dispatch("click");
    await settle();
    assert.equal(noticeText(doc), "远程工作区的任务暂时不能从这里打开。");
  }],

  ["空列表显示空态；资源变更通知后重新读取", async () => {
    const { page, doc } = await mount({ model: emptyModel(), tools: {} });
    assert.equal(element(doc, "list").children[0].textContent, "没有任务新任务会自动出现在这里。");
    page.setModel(model());
    page.notify(TASKS_URI);
    await waitReload();
    assert.deepEqual(titles(doc), ["修登录 bug", "写周报"]);
  }],

  ["语言跟随宿主", async () => {
    const { doc } = await mount({ model: model({ locale: "en-US" }), tools: {} });
    assert.equal(element(doc, "heading").textContent, "最近任务");
    assert.equal(doc.documentElement.lang, "en");
  }],

  ["宿主主题变量写入根元素", async () => {
    const { doc } = await mount({ model: model(), tools: {} });
    assert.equal(doc.documentElement.style.values["--color-foreground"], "#123456");
    assert.equal(doc.documentElement.dataset.theme, "light");
  }],

  ["扩展进程是旧版本：提示重启 ZCode，而不是笼统的连接失败", async () => {
    // 回归：扩展进程用 import() 加载入口，命中 Node 的 ESM 模块缓存就不会重读文件，
    // 于是仍在跑旧版本（资源是 /tasks 而不是 /state）。这种情况必须直接说「请重启」。
    const { page, doc } = await mount({ model: model(), tools: {}, resources: ["ui://recent-tasks@smoke/tasks"] });
    assert.equal(noticeText(doc), "扩展代码还是旧版本，请重启 ZCode 后再打开本面板。");
    assert.equal(element(doc, "notice-action").hidden, true);
    // 视图模型读不到，界面用兜底文案（中文），不是英文键名。
    assert.equal(element(doc, "heading").textContent, "最近任务");
    assert.equal(element(doc, "search").placeholder, "搜索标题");
    assert.deepEqual(page.calls.filter(([kind]) => kind === "readResource"), []);
  }],

  ["既没有 state 也没有旧版 tasks 资源：提示重启并说明缺数据", async () => {
    const { doc } = await mount({ model: model(), tools: {}, resources: ["ui://x/other"] });
    assert.equal(noticeText(doc), "没有找到任务列表数据，请重启 ZCode 后再打开本面板。");
    assert.equal(element(doc, "heading").textContent, "最近任务");
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
