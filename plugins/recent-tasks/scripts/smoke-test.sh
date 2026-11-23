#!/usr/bin/env bash
# 最近任务扩展的测试入口：构建 → 行数门禁 → 语法检查 → 类型检查 → 清单校验 → 冒烟测试。
#
# 用法：bash scripts/smoke-test.sh
#
# - Node 用 nvm 的 24.x（与仓库 scripts/build-desktop-preview.sh 同一约定）；
# - 行数门禁：源文件单个不超过 300 行（构建产物 ui/index.html 不计入，它是模板与脚本的合并结果）；
# - 类型检查借用仓库的 TypeScript，对扩展入口及其依赖做 checkJs（JSDoc 强类型），不落盘配置；
# - 全程日志写入仓库 logs/recent-tasks/smoke-test.log。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(dirname "$SCRIPT_DIR")"
REPO_ROOT="$(cd "$PLUGIN_ROOT/../.." && pwd)"
cd "$REPO_ROOT"

LOG_DIR="logs/recent-tasks"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/smoke-test.log"

# 环境准备：nvm 的 Node 24.x 前置到 PATH（mise 未安装，本机用 nvm 提供工具链）
NVM_NODE_BIN="$HOME/.nvm/versions/node/v24.18.0/bin"
if [ ! -x "$NVM_NODE_BIN/node" ]; then
  echo "[错误] 未找到 $NVM_NODE_BIN/node，请确认 nvm 已安装 Node 24.18.0" >&2
  exit 1
fi
export PATH="$NVM_NODE_BIN:$PATH"

TSC="node_modules/typescript/bin/tsc"
TSX="node_modules/.bin/tsx"
if [ ! -f "$TSC" ] || [ ! -x "$TSX" ]; then
  echo "[错误] 未找到仓库的 TypeScript 或 tsx（$TSC / $TSX），请先在仓库根目录安装依赖" >&2
  exit 1
fi

# 行数门禁：超过 300 行的源文件逐个列出，由 set -e 让脚本失败。构建产物不计入。
check_line_count() {
  local file lines
  for file in "$@"; do
    lines="$(wc -l < "$file" | tr -d ' ')"
    if [ "$lines" -gt 300 ]; then
      echo "[失败] $file 有 $lines 行，超过 300 行上限" >&2
      return 1
    fi
  done
}

{
  echo "[$(date '+%F %T')] recent-tasks 测试开始"
  echo "--- 构建面板页面"
  node "$PLUGIN_ROOT/scripts/build-panel.mjs"
  echo "--- 行数门禁（源文件 ≤300 行，产物不计）"
  check_line_count "$PLUGIN_ROOT"/extension/*.mjs "$PLUGIN_ROOT"/ui/panel.template.html "$PLUGIN_ROOT"/scripts/*.mjs
  wc -l "$PLUGIN_ROOT"/extension/*.mjs "$PLUGIN_ROOT"/ui/panel.template.html "$PLUGIN_ROOT"/scripts/*.mjs
  echo "--- 语法检查"
  for file in "$PLUGIN_ROOT"/extension/*.mjs "$PLUGIN_ROOT"/scripts/*.mjs; do node --check "$file"; done
  echo "--- 类型检查（checkJs + strict）"
  node "$TSC" --noEmit --allowJs --checkJs --strict \
    --target es2022 --module nodenext --moduleResolution nodenext --skipLibCheck --types node \
    "$PLUGIN_ROOT/extension/index.mjs"
  echo "--- 清单校验（宿主的清单校验代码）"
  "$TSX" "$PLUGIN_ROOT/scripts/validate-manifest.mjs"
  echo "--- 冒烟测试（扩展入口）"
  node "$PLUGIN_ROOT/scripts/smoke-test.mjs"
  echo "--- 冒烟测试（面板页面）"
  node "$PLUGIN_ROOT/scripts/page-smoke.mjs"
  echo "[$(date '+%F %T')] 全部通过"
} 2>&1 | tee "$LOG_FILE"
