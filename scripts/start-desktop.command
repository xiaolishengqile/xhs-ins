#!/bin/zsh
set -eu
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"
if [[ ! -x "$PROJECT_DIR/.venv-desktop/bin/python" ]]; then
  print "尚未安装桌面运行环境。请先按 docs/desktop.md 完成安装。"
  read "?按回车退出…"
  exit 1
fi
if ! "$PROJECT_DIR/.venv-desktop/bin/python" -c 'import PySide6.QtWidgets, PySide6.QtNetwork' >/dev/null 2>&1; then
  print "桌面依赖缺失，请按 docs/desktop.md 安装 desktop/requirements.txt。"
  read "?按回车退出…"
  exit 1
fi
# 访达启动的环境可能没有包管理器路径；保留现有路径并补充常见安装位置。
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
exec "$PROJECT_DIR/.venv-desktop/bin/python" "$PROJECT_DIR/desktop/main.py" "$@"
