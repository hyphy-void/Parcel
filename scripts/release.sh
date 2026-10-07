#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$task_root"
./scripts/build.sh
mkdir -p dist
task_version="${PARCEL_BUILD_VERSION:-0.1.0}"
for task_arch in arm64 amd64 arm; do
  task_name="parcel-linux-$task_arch"
  CGO_ENABLED=0 GOOS=linux GOARCH="$task_arch" GOARM=7 go build -trimpath -buildvcs=false -ldflags "-s -w -X github.com/hyphy-void/Parcel/internal/parcel.Version=$task_version" -o "dist/$task_name" ./cmd/parcel
done
(cd dist && sha256sum parcel-linux-* > SHA256SUMS)
echo 'Release binaries and SHA256SUMS are in dist/.'
