#!/bin/zsh
set -e
cd "$(dirname "$0")/.."
coal_node="$(command -v node || true)"
if [[ -z "$coal_node" ]]; then
  for coal_candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [[ -x "$coal_candidate" ]]; then coal_node="$coal_candidate"; break; fi
  done
fi
if [[ -z "$coal_node" ]]; then
  echo "请先安装 Node.js 24 或更高版本。"
  exit 1
fi
exec "$coal_node" desktop/launch.mjs
