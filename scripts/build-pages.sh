#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
npm --prefix web ci
# Build directly into the Pages staging tree; preserve the embedded local UI.
VITE_ADMIN_AUTH=access npm --prefix web run build -- --outDir ../dist/pages-web --emptyOutDir
npm --prefix cloudflare ci
PARCEL_PAGES_WEB_DIR=dist/pages-web npm --prefix cloudflare run build
