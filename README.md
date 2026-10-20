# Parcel

**Upload. Share. Disappear.**

自托管的临时文件中转站：上传文件，生成分享链接，通过密码、有效期和下载次数控制分享，失效后自动清理。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fhyphy-void%2FParcel)

推荐新用户使用 **Workers + D1 + 私有 R2**。Cloudflare V3 的新分享使用浏览器端到端加密：文件在上传前分块加密，R2 保存密文，接收者在浏览器解密并流式保存。按 [图文部署手册](https://parcelwiki.pages.dev) 完成密码 + TOTP（或可选 Access）、R2 凭据、CORS 和运行时配置，再启用实例。教程截图已脱敏并以无损 WebP 随仓库保存。按钮自动准备资源与 D1 schema；首次部署保持维护模式。Workers Free 不代表 R2 无限免费，新实例默认 9 GB 应用配额，免费额度与账单按账户计算。

CLI 自动准备部署：`npm run deploy:bootstrap -- --config .parcel-v3/deploy.json`，完整步骤见 [V3 部署说明](docs/v3-deployment.md)。源码按 [MIT](LICENSE) 许可发布。

v0.1 采用 Go + React/TypeScript + SQLite，前端内嵌在单个二进制中，局域网运行时无需 Node、数据库服务或反向代理。默认文件存储在本机 SSD 上，可选用私有 R2 直传/直下载。Go 模式可通过 Cloudflare Tunnel 与 Caddy 提供网页、鉴权及管理 API，详见 [Tunnel 部署说明](docs/tunnel-deployment.md)。Pages 模式采用静态前端 + API Gateway + Access 身份验证，接入步骤见 [Pages 部署说明](docs/pages-deployment.md)。

V3 支持 Workers Free 的 Cloudflare 原生部署模式：Workers 托管前端与 API，D1 负责权威状态和原子事务，密文在浏览器和 R2 之间直传，核心链路不依赖树莓派。端到端加密严格限定 Cloudflare V3；独立 Go 和连接 Origin 的 Pages 构建保留原 UI 与传输协议，未提供文件 E2EE。构建、自动部署与升级限制见 [V3 部署说明](docs/v3-deployment.md)。

V3 管理员可选择 Access 或“管理员密码 + TOTP 动态验证码”：支持认证器扫码绑定、一次性恢复码和更换认证器。现有实例须设置 `ADMIN_AUTH=totp`、完成初始化并解除管理路径的 Access 拦截，才会停止邮箱验证码登录。切换步骤见 [V3 管理员认证](docs/v3-deployment.md#管理员密码--totp-登录替代邮箱验证码)。

管理员登录后上传单个文件，设置可选密码、有效期与下载次数（可选不限次数），生成一个分享链接。不限次数时仍保留有效期与密码保护。支持分块上传恢复、HTTP Range 下载、原子下载计数、自动清理与崩溃恢复。

### Cloudflare V3 端到端加密

每份文件使用独立随机 256 位密钥，按 16 MiB 原文分块执行 AES-GCM；每块增加 12 字节随机 nonce 和 16 字节认证标签。文件名、媒体类型和原文 SHA-256 与文件密钥一起密封。完整链接的 `#k=…` 保存随机 32 字节密钥材料，不进入 HTTP 请求或 Parcel API；有密码时，独立盐的 Argon2id 与链接材料经 HKDF 保护密钥信封。另一份不同盐的密码凭据只用于服务端在线授权，不能当作解密密钥。

上传刷新后需保留网站数据、重选原文件并核验完整 SHA-256。接收端先把密文暂存 IndexedDB，再逐块解密、校验并流式写盘，需约两份文件的磁盘空间及浏览器存储配额。创建者须保留完整链接，并在换设备或清理网站数据前导出带独立口令的加密密钥备份。服务器、管理员登录或 `SESSION_SECRET` 都不能恢复丢失的文件密钥。修改密码只重包密钥，不重传文件；已取得密钥和密文的副本无法撤回。

服务器仍可见大小、分享 ID、次数、有效期和请求元信息；此方案信任加载的网页、浏览器与终端，不能抵抗恶意网页更新、扩展或本机攻击。升级新增 `0004_e2ee.sql` 与 `0005_download_admissions.sql`，迁移本身不删除现有 D1/R2 数据；旧 V3 未加密分享返回不兼容状态，需要重新上传。不能把新版加密分享回滚为 Go 可读文件。

## 本地启动

构建需要 Go 1.26 或更新的兼容版本、Node 24 和 npm。Go 的自动工具链下载可以从已安装的旧版 Go 启动构建。

```bash
./scripts/build.sh
./bin/parcel admin-password
./bin/parcel serve
```

默认访问 `http://127.0.0.1:8080`。管理员密码交互输入，数据默认保存到 `./data`；无内置默认密码。

局域网运行示例：

```bash
export PARCEL_LISTEN_ADDR=192.168.5.16:8080
export PARCEL_BASE_URL=http://192.168.5.16:8080
./bin/parcel serve
```

只允许绑定明确的内网或回环 IP，不允许 `0.0.0.0` 或公网 IP。HTTP 模式适用于可信局域网；链接只对能到达该内网地址的接收者有效。

## 开发与验证

```bash
npm --prefix web run dev            # 另一个终端运行 Go 服务
npm --prefix web run build
go test -race ./...
go vet ./...
cd web && npx playwright install chromium firefox && npm run test:e2e
```

Go 的资源嵌入依赖 `web/dist`，首次运行 Go 测试/开发服务前需先构建前端。开发代理仅支持默认的 `127.0.0.1:8080` 后端和 `127.0.0.1:5173` 前端地址。

生成 Linux ARM64、ARMv7、AMD64 产物与校验和：`./scripts/release.sh`。push/PR 自动运行 CI；推送正式 `vX.Y.Z` tag 会在测试通过后发布 GitHub Release。树莓派可直接安装预编译产物，无需 Go/Node。已安装升级工具后，使用 `sudo /usr/local/lib/parcel/update.py --version vX.Y.Z` 一键升级，支持校验、健康检查和失败回滚；可选启用每日补丁更新，详见[发布与升级说明](docs/operations.md#8-ci-发布与树莓派升级)。独立的大文件验收：`python3 scripts/acceptance.py`，默认生成真实 8 GiB 文件，需约 35 GiB 可用空间。实际磁盘写满与挂载丢失验收：`python3 scripts/storage-acceptance.py`，需要可使用 sudo 的测试环境。

## 文档

- [设计与开发计划](docs/development-plan.md)
- [安装、配置与运维](docs/operations.md)
- [验收报告与未测项目](docs/acceptance.md)
- [真实局域网设备验收步骤](docs/lan-acceptance.md)

下载次数指首次准许传输消耗的下载资格；同一有效会话重试与续传不重复扣次，网络中断不退还资格。V3 分别显示密文接收与解密保存进度，最终保存结果仍须在浏览器下载列表或所选目录确认。Go 模式继续由原生下载列表显示保存进度。

### 私有 R2 存储

可选启用树莓派鉴权 + 私有 R2 预签名直传/直下载，新文件内容不经过 Tunnel。保留旧本地文件，所有文件统一使用 16 MiB Multipart 分块（最后一块按实际大小），更大文件二次确认并支持分块续传；默认 9 GB R2 存储保护，下载地址有效 5 分钟。配置和 schema 1 / 2 → 3 升级流程见 [docs/r2-storage.md](docs/r2-storage.md)。

### Pages / Access 网关

`./scripts/build-pages.sh` 生成 `dist/pages`，由 Cloudflare 承载页面和 API 初验；Go 在 Pi 保留 SQLite 与 R2 控制面。管理员使用 Access 登录，内部 Origin 使用 Service Auth 与 Go HMAC 验签。配置和切换步骤见 [docs/pages-deployment.md](docs/pages-deployment.md)。
