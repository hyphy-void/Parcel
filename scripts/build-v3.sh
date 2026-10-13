#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
if [[ "${1:-}" != '--skip-install' ]]; then
  [[ $# == 0 ]] || { echo 'Usage: build-v3.sh [--skip-install]' >&2; exit 1; }
  npm --prefix web ci
  npm --prefix cloudflare ci
fi
VITE_ADMIN_AUTH=access npm --prefix web run build -- --outDir ../dist/v3-web --emptyOutDir
node cloudflare/v3/build.mjs
