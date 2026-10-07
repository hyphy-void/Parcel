#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
task_version="${PARCEL_BUILD_VERSION:-0.1.0}"
[[ "$task_version" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'Invalid build version' >&2; exit 1; }
npm --prefix web ci
npm --prefix web run build
mkdir -p bin
CGO_ENABLED=0 go build -trimpath -buildvcs=false -ldflags "-s -w -X github.com/hyphy-void/Parcel/internal/parcel.Version=$task_version" -o bin/parcel ./cmd/parcel
echo 'Built bin/parcel with embedded frontend.'
