# Repository Guidelines

## Project Structure & Module Organization
Parcel is a Go file-sharing service with React/TypeScript UI and SQLite storage. `cmd/parcel/` contains the CLI; `internal/config/` handles configuration; `internal/parcel/` implements authentication, uploads, downloads, cleanup, and SQL migrations. `web/src/` contains UI code, `web/tests/` Playwright tests, and `web/embed.go` embeds generated `web/dist/`. Deployment templates live in `deploy/`, build and acceptance tools in `scripts/`, and operational documentation in `docs/`. Generated `bin/`, `dist/`, and runtime data are ignored.

## Build, Test, and Development Commands
Use Node 24 and the Go toolchain in `go.mod`. Run from the repository root:

- `./scripts/build.sh`: build UI and produce `bin/parcel`.
- `./bin/parcel admin-password` then `./bin/parcel serve`: initialize local credentials and run at `127.0.0.1:8080`.
- `npm --prefix web run dev`: start Vite; run the Go backend separately on port 8080.
- `go test -race ./...` and `go vet ./...`: check backend behavior and correctness; build `web/dist/` first.
- `npm --prefix web run typecheck`: validate TypeScript.
- `cd web && npx playwright install chromium firefox && npm run test:e2e`: run browser tests.
- `PARCEL_TEST_BINARY="$PWD/bin/parcel" python3 -m unittest discover -s scripts/tests -v`: test the updater.

## Product Naming & Documentation
Use **Parcel** as the product name. When the deployment architecture needs to be distinguished, call it **Cloudflare 部署** in Chinese or **Cloudflare deployment** in English; describe its components as Workers + D1 + private R2 when useful.

Do not use **V3**, **Cloudflare V3**, or similar internal generation labels as product or architecture names in user-facing replies, UI, README files, deployment documentation, or the tutorial site. Do not infer a branch name or release version from these historical labels.

Preserve existing technical identifiers, paths, filenames, commands, and configuration values unless a separate refactor is requested. Quote their actual names when required for correct instructions; this exception does not make them product names or justify adding the old label to surrounding prose.

## Coding Style & Naming Conventions
Format Go with `gofmt`; use tabs, lowercase package names, and exported CamelCase identifiers. Match existing TypeScript/CSS formatting: two spaces, double quotes, semicolons; Prettier is available in `web/`. Use `*_test.go`, `*.spec.ts`, and Python `test_*.py` filenames.

## Testing Guidelines
Use Go testing, Playwright, and Python unittest. Cover authentication, resumable transfers, quota accounting, and recovery. No coverage threshold is configured. Large-file and storage acceptance scripts are opt-in; consult `docs/operations.md` for disk and sudo requirements.

## Cross-Compilation & Raspberry Pi Deployment
Build on the development machine, then deploy to the 64-bit Pi; do not build on the Pi by default:

```bash
./scripts/release.sh
scp dist/parcel-linux-arm64 hyphy@100.125.38.115:/home/hyphy/gitcode/Parcel/bin/parcel.next
```

Use Tailscale SSH: `ssh hyphy@100.125.38.115`. The remote checkout is `/home/hyphy/gitcode/Parcel`; the systemd binary is `/opt/parcel/parcel`. Compare local/remote SHA-256 before installation. Inspect remote changes before synchronizing source; never reset them. Stop `parcel`, retain the previous binary, install the verified artifact, restart, and verify `systemctl is-active parcel` and `/readyz` using the configured base URL. Restore the previous binary if verification fails. Preserve `/etc/parcel/` configuration and `/srv/parcel` data; follow `docs/operations.md` for schema changes.

## Commit & Pull Request Guidelines
Follow existing `feat:`, `fix:`, and `docs:` commit prefixes with concise descriptions. PRs should explain behavior, list validation, link relevant issues, and include screenshots for UI changes. Never commit credentials, databases, or uploaded files; preserve unrelated working-tree changes.
