// 用宿主的清单校验代码核对插件清单（docs/plugins/extension-host.md §5、§16.2、§17.7）。
//
// 宿主读清单时用的就是这几个函数：清单不合法时扩展显示「清单非法」、版本对不上显示「版本不兼容」，
// 两种情况扩展都不会激活。这里直接加载仓库里的同一份实现，避免在插件里另写一套校验规则。
//
// 依赖仓库的 tsx 与 @zcode/shared 源码，只能在仓库检出目录里运行（由 scripts/smoke-test.sh 调用）。
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXTENSION_API_VERSION,
  isExtensionEngineCompatible,
  validateExtensionManifest,
} from "../../../packages/shared/src/extension-host/manifest.ts";
import { parseManifestSlots } from "../../../packages/shared/src/extension-host/manifestSlots.ts";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 本机已安装的 ZCode 3.19.1 里的扩展 API 版本（从安装包的 app.asar 中核对得到）。 */
const INSTALLED_HOST_API_VERSION = "1.4.0";

/** @returns {any} 插件清单 */
const readManifest = () => JSON.parse(readFileSync(resolve(PLUGIN_ROOT, ".zcode-plugin/plugin.json"), "utf8"));

let failed = 0;
/** @param {string} name @param {() => Promise<void>} run */
const check = async (name, run) => {
  try {
    await run();
    console.log(`通过  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`失败  ${name}\n${error instanceof Error ? error.stack : String(error)}`);
  }
};

const manifest = readManifest();

await check("extension 键通过宿主的严格校验", async () => {
  const result = validateExtensionManifest(manifest.extension, EXTENSION_API_VERSION);
  assert.deepEqual(result.status === "ok" ? result.status : result, "ok", "清单非法或版本不兼容");
});

await check("版本要求与本机已安装的宿主兼容", async () => {
  assert.equal(isExtensionEngineCompatible(manifest.extension.engines.zcode, INSTALLED_HOST_API_VERSION), true);
});

await check("顶层 slots 全部可用且没有被忽略的插槽", async () => {
  const parsed = parseManifestSlots(manifest.slots);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.ignored, []);
  const targets = parsed.items.map((item) => `${item.slot}:${item.target.kind}:${item.target.id}`);
  assert.deepEqual(targets, ["nav.primary:view:recent-tasks", "sidePane.launcher:view:recent-tasks"]);
});

await check("入口与引用的视图都存在", async () => {
  await access(resolve(PLUGIN_ROOT, manifest.extension.main));
  const views = new Set(manifest.extension.contributes.views.map((view) => view.id));
  for (const item of parseManifestSlots(manifest.slots).items) {
    if (item.target.kind === "view") assert.ok(views.has(item.target.id), `插槽条目引用了未声明的视图：${item.target.id}`);
  }
});

await check("申请的档位与协议版本是宿主认识的取值", async () => {
  // sessions.write 只用于「打开会话」这一个动作；不读会话正文，所以不声明 rows 协议。
  assert.deepEqual(manifest.extension.grants, ["sessions.write"]);
  assert.deepEqual(manifest.extension.protocols, { sessions: 1 });
  // 协议版本要与宿主一致：宿主认得的取值见 extension-host-protocol 的 EXTENSION_PROTOCOL_VERSIONS。
  const { EXTENSION_PROTOCOL_VERSIONS } = await import(
    "../../../packages/shared/src/extension-host/grants.ts"
  );
  for (const [name, version] of Object.entries(manifest.extension.protocols ?? {})) {
    assert.equal(version, EXTENSION_PROTOCOL_VERSIONS[name], `protocols.${name} 与宿主不一致`);
  }
});

console.log(`\n共 5 项，${5 - failed} 项通过，${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
