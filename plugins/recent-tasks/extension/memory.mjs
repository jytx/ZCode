// 上次位置记忆：记住每个工作区最近一次打开任务的时刻，让「找不着任务」这件事有落点。
//
// 存储位置：插件自己的数据目录（ctx.extension.dataPath）下的 memory.json。
// 这是插件自己的使用痕迹，不是业务数据，存自己的目录最合适；插件卸载时随数据目录一起清掉。
//
// 写入是尽力而为：磁盘满、权限异常都不能影响跳转，所以写失败只记日志、不上抛。
// 读失败（文件不存在、格式坏了）按「没有记忆」处理，插件照常工作。

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 记忆文件名（放在插件数据目录下）。 */
const MEMORY_FILE = "memory.json";
/** 记忆文件格式版本；结构变了才升版，读到更高版本就当没有记忆。 */
const MEMORY_VERSION = 1;

/**
 * 工作区的记忆键：远程工作区用 identity（同名路径不同主机必须分开），本地用路径。
 * @param {{workspacePath: string, workspaceIdentity?: string}} session
 * @returns {string}
 */
export function workspaceKey(session) {
  return session.workspaceIdentity?.trim() || session.workspacePath;
}

/**
 * 记忆内容。
 * @typedef {object} Memory
 * @property {number} version
 * @property {Record<string, MemoryEntry>} entries 按工作区键索引
 */

/**
 * 一个工作区的记忆。
 * @typedef {object} MemoryEntry
 * @property {string} sessionId 上次打开的任务
 * @property {string} title 上次打开时的标题（任务被删后仍能显示）
 * @property {number} openedAt 上次打开的毫秒时间戳
 */

/** @returns {Memory} 空记忆 */
export function emptyMemory() {
  return { version: MEMORY_VERSION, entries: {} };
}

/**
 * 校验读到的内容是不是记忆文件；不是就当没有记忆。
 * @param {unknown} raw
 * @returns {Memory | null}
 */
export function parseMemory(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const record = /** @type {{version?: unknown, entries?: unknown}} */ (raw);
  if (record.version !== MEMORY_VERSION) return null;
  if (record.entries === null || typeof record.entries !== "object") return null;
  /** @type {Record<string, MemoryEntry>} */
  const entries = {};
  for (const [key, value] of Object.entries(record.entries)) {
    if (value === null || typeof value !== "object") continue;
    const entry = /** @type {{sessionId?: unknown, title?: unknown, openedAt?: unknown}} */ (value);
    if (typeof entry.sessionId !== "string" || typeof entry.openedAt !== "number") continue;
    entries[key] = {
      sessionId: entry.sessionId,
      title: typeof entry.title === "string" ? entry.title : "",
      openedAt: entry.openedAt,
    };
  }
  return { version: MEMORY_VERSION, entries };
}

/**
 * 读记忆。文件不存在或读不出来都按「没有记忆」处理，不影响面板工作。
 * @param {string} dataPath 插件数据目录
 * @returns {Promise<Memory>}
 */
export async function readMemory(dataPath) {
  try {
    return parseMemory(JSON.parse(await readFile(join(dataPath, MEMORY_FILE), "utf8"))) ?? emptyMemory();
  } catch {
    return emptyMemory();
  }
}

/**
 * 写记忆。先写临时文件再改名，避免中途失败留下半个文件。
 * @param {string} dataPath 插件数据目录
 * @param {Memory} memory
 * @returns {Promise<boolean>} 是否写成功
 */
export async function writeMemory(dataPath, memory) {
  const target = join(dataPath, MEMORY_FILE);
  const temporary = `${target}.tmp`;
  try {
    await mkdir(dataPath, { recursive: true });
    await writeFile(temporary, JSON.stringify(memory), "utf8");
    await rename(temporary, target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 记下一次打开：新记录放在最前，同一工作区只保留最近一条。
 * 纯函数：返回新记忆，不改入参。
 * @param {Memory} memory
 * @param {{workspacePath: string, workspaceIdentity?: string, sessionId: string}} session
 * @param {string} title 任务标题
 * @param {number} openedAt 打开时刻（毫秒时间戳）
 * @returns {Memory}
 */
export function recordOpened(memory, session, title, openedAt) {
  const key = workspaceKey(session);
  return { version: MEMORY_VERSION, entries: { ...memory.entries, [key]: { sessionId: session.sessionId, title, openedAt } } };
}

/**
 * 取某个工作区的记忆。
 * @param {Memory} memory
 * @param {string} key 工作区键
 * @returns {MemoryEntry | null}
 */
export function findEntry(memory, key) {
  return memory.entries[key] ?? null;
}
