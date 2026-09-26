#!/bin/zsh
set -eu
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
cd "$PROJECT_DIR"
exec node "$PROJECT_DIR/scripts/open-web.js" "$@"
