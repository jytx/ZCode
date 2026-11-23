// 构建面板页面：把两个页面脚本源文件内联进模板，产出 ui/index.html。
//
// 为什么需要这一步：宿主沙箱只服务一个 HTML 文件（packages/desktop/src/main/pluginSandbox/protocol.ts），
// 页面没法引同源脚本；而视图入口必须是插件根目录下的一个文件（宿主直接读它的内容）。
// 所以页面脚本以源文件形式维护（各自不超过 300 行），构建时内联成产物。
//
// 产物叫 index.html 而不是 panel.html：宿主读视图入口时用的是扩展注册的 entry，
// 而扩展进程加载入口用的是 import()，命中 Node 的 ESM 模块缓存就不会重新读文件
// （「重新加载扩展」因此读不到新代码）。产物沿用惯例名，命中旧 entry 时也能打开。
//
// 用法：node scripts/build-panel.mjs
// 产物：ui/index.html（清单里的视图入口指向它）。改完脚本要重新构建再安装。
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(PLUGIN_ROOT, "ui", "panel.template.html");
const OUTPUT = join(PLUGIN_ROOT, "ui", "index.html");
/** 内联顺序即执行顺序：core 先定义 window.__rt，view 再用它。 */
const SCRIPTS = ["extension/panel-core.mjs", "extension/panel-view.mjs"];
/** 模板里的占位符。 */
const PLACEHOLDER = "<!--__PANEL_SCRIPTS__-->";

/**
 * 内联一个脚本文件。脚本里出现 `</script>` 会提前结束 HTML 标签，
 * 所以把结束标签的斜杠转义——与宿主给 Gen UI 注入脚本的处理一致。
 * @param {string} source
 * @returns {string}
 */
function toScriptTag(source) {
  return `<script>\n${source.replace(/<\/script/giu, "<\\/script")}\n</script>`;
}

const template = await readFile(TEMPLATE, "utf8");
if (!template.includes(PLACEHOLDER)) {
  throw new Error(`模板缺少占位符 ${PLACEHOLDER}`);
}
const scripts = [];
for (const file of SCRIPTS) {
  scripts.push(toScriptTag(await readFile(join(PLUGIN_ROOT, file), "utf8")));
}
const html = template.replace(PLACEHOLDER, scripts.join("\n"));
await writeFile(OUTPUT, html, "utf8");
console.log(`已生成 ${OUTPUT}（${html.split("\n").length} 行，含 ${SCRIPTS.length} 个脚本）`);
