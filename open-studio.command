#!/bin/zsh -l
set -eu
cd -- "${0:a:h}"
if [[ ! -x node_modules/.bin/vite ]]; then
  npm ci
fi

prepare_python() {
  if [[ ! -x .venv/bin/python ]]; then
    command -v python3 >/dev/null || return 1
    python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || return 1
    python3 -m venv .venv || return 1
  fi
  .venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
}

if ! prepare_python; then
  print -u2 '本地 Python 环境未就绪，仍可在浏览器里绘制。'
fi
npm run dev -- --host 127.0.0.1 --port 5193 --open '/'
