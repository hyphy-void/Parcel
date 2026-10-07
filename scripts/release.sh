#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
if [[ "${1:-}" != '--skip-web' ]]; then
  [[ $# == 0 ]] || { echo 'Usage: release.sh [--skip-web]' >&2; exit 1; }
  npm --prefix web ci
  npm --prefix web run build
else
  [[ $# == 1 && -f web/dist/index.html ]] || { echo 'Build web/dist first.' >&2; exit 1; }
fi
mkdir -p dist
task_version="${PARCEL_BUILD_VERSION:-0.1.0}"
[[ "$task_version" =~ ^[A-Za-z0-9._-]+$ ]] || { echo 'Invalid build version' >&2; exit 1; }
for task_arch in arm64 amd64 arm; do
  task_name="parcel-linux-$task_arch"
  CGO_ENABLED=0 GOOS=linux GOARCH="$task_arch" GOARM=7 go build -trimpath -buildvcs=false -ldflags "-s -w -X github.com/hyphy-void/Parcel/internal/parcel.Version=$task_version" -o "dist/$task_name" ./cmd/parcel
done
# Keep this in sync with supported schema in internal/parcel/app.go.
printf '{"version":"%s","schema_version":1}\n' "$task_version" > dist/release.json
(cd dist && sha256sum parcel-linux-arm64 parcel-linux-amd64 parcel-linux-arm release.json > SHA256SUMS)
echo 'Release binaries, compatibility metadata and SHA256SUMS are in dist/.'
