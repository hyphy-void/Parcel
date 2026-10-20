<h1 align="center">Parcel</h1>

<p align="center"><strong>上传。分享。到期清理。</strong></p>
<p align="center">在自己的 Cloudflare 账户上，搭建端到端加密的临时文件分享站。<br>浏览器加密，链接分享，到期自动清理。</p>

<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>

<p align="center">
  <a href="https://github.com/hyphy-void/Parcel/actions/workflows/ci.yml"><img src="https://github.com/hyphy-void/Parcel/actions/workflows/ci.yml/badge.svg" alt="持续集成"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT 许可证"></a>
  <a href="docs/e2ee-protocol.md"><img src="https://img.shields.io/badge/encryption-AES--256--GCM-2ea44f" alt="AES-256-GCM 加密"></a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fhyphy-void%2FParcel"><img src="https://deploy.workers.cloudflare.com/button" alt="部署到 Cloudflare"></a>
</p>

<p align="center">
  <a href="https://parcelwiki.pages.dev/zh">中文图文教程</a> ·
  <a href="#开始部署">开始部署</a> ·
  <a href="docs/v3-deployment.md">部署与维护</a> ·
  <a href="docs/e2ee-protocol.md">加密协议</a>
</p>

---

发一份大文件，给对方一个链接，再为这次分享设定结束时间。Parcel 将端到端加密、断点续传和自动清理放进同一个分享流程，运行在你自己的 Cloudflare 账户中。

文件在发送者的浏览器中加密，直传私有 R2；接收者在浏览器中解密并保存。文件密钥与原始文件名封装在加密信封里，服务端无法解包读取。

## 为什么选择 Parcel？

- **先加密，再上传。** 每份文件使用独立随机 256 位密钥，通过 AES-256-GCM 逐块加密认证，保存时再核对完整文件的 SHA-256。
- **为分享设定结束时间。** 设置分享密码、有效期和下载次数，也可选择不限次数；需要提前结束时，随时撤销分享。
- **中断之后，接着传。** 上传可在重选并校验原文件后续传；下载会保留完整缓存块，刷新页面后继续接收。
- **大文件，分块处理。** 加密和保存采用分块、流式处理，内存占用不随文件总大小增长。默认单文件上限为 **8 GiB**，可按部署需求调整。
- **管理员入口，双重验证。** 密码 + TOTP 登录，支持扫码或手动绑定认证器，并提供八个恢复码。管理员密码与分享密码分别管理。
- **部署在自己的账户里。** Workers 托管页面与 API，D1 管理状态，私有 R2 保存密文。分享到期、撤销或下载次数耗尽后，由定时任务清理并回收存储空间。

## 从文件到链接

1. **上传。** 登录后选择文件，设置分享密码、有效期和下载上限。浏览器先计算完整哈希，再逐块加密并直传 R2。
2. **分享。** 复制包含 `#k=…` 的完整链接。设置了分享密码时，建议通过另一条渠道发送密码。
3. **接收。** 对方打开完整链接，按需输入密码，接收加密文件块。接收完成后，点击“保存解密文件”，浏览器逐块验证、解密并流式写入磁盘。
4. **管理。** 在管理页面撤销分享或修改密码。更换密码会重新封装密钥信封并更新在线授权凭据，无需重传文件；操作浏览器需持有本机分享密钥，或先导入密钥备份。

> **保留完整链接，备份本机分享密钥。** 清理网站数据或更换设备前，请导出加密密钥备份。管理员登录不能找回丢失的文件密钥。

## 文件如何受到保护

![Parcel 架构：发送者浏览器加密，私有 R2 保存密文，Workers + D1 管理访问授权，接收者浏览器验证、解密并保存文件。](docs/images/architecture.webp)

文件按 **16 MiB** 分块加密。文件名、媒体类型、修改时间、原文哈希与文件密钥一起保存在经过认证的加密信封中。分享链接的 `#k=…` 片段携带随机链接材料；URL 片段不随 HTTP 请求发送，Parcel 也不会把它传入 API。设置分享密码后，信封还会获得基于 Argon2id 的密码保护。

服务端可见文件大小、分享 ID、访问规则、下载次数与请求元信息。加密机制信任实际加载的页面代码、浏览器和设备。文件格式、密钥派生、信任边界与测试范围见[加密协议](docs/e2ee-protocol.md)。

## 开始部署

准备一个已开通 Workers、D1 和 R2 的 Cloudflare 账户，以及用于本机初始化的 Node.js 24 与 Bash。Windows 可使用 Git Bash 或 WSL。

[中文图文教程](https://parcelwiki.pages.dev/zh)提供完整的控制台操作步骤，配套[配置工具](https://parcelwiki.pages.dev/zh#config)可生成运行时变量与 R2 CORS 策略。

### 1. 创建应用

[![部署到 Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https%3A%2F%2Fgithub.com%2Fhyphy-void%2FParcel)

使用 Node **24**、仓库根目录 `/`、构建命令 `npm run build` 和部署命令 `npm run deploy`。部署过程会应用 D1 迁移；首次配置期间保持 **`ACTIVE=false`**。

### 2. 配置访问地址与存储

通过[配置工具](https://parcelwiki.pages.dev/zh#config)填写 `PUBLIC_URL`、R2 地址与桶名，并将生成的 CORS 策略应用到私有桶。保持 **`ADMIN_AUTH=totp`**，使用管理员密码与认证器动态码登录。

保存以下长期 Worker Secrets：

| Secret | 用途与要求 |
| --- | --- |
| `SESSION_SECRET` | 独立生成的 64 位十六进制随机值，后续部署保持不变。 |
| `R2_ACCESS_KEY_ID` | 限定到应用所用存储桶的 R2 S3 Access Key ID。 |
| `R2_SECRET_ACCESS_KEY` | 与 Access Key ID 配套的 R2 S3 Secret，凭据需具备 Object Read & Write 权限。 |

### 3. 初始化管理员

在本机生成临时初始化令牌：

```bash
git clone https://github.com/hyphy-void/Parcel.git
cd Parcel
npm run admin:setup-token
```

将 Git 忽略文件 `.parcel-v3/admin-setup-token.txt` 的内容保存为临时 Worker Secret `ADMIN_SETUP_TOKEN`。打开应用的 `/login` 页面，设置至少 12 位管理员密码，扫码或手动绑定认证器，再输入六位 TOTP 动态码确认。

### 4. 保存恢复码，启用分享

单独保存**八个恢复码**，然后移除 `ADMIN_SETUP_TOKEN`。在新窗口验证密码与 TOTP 登录后，将 **`ACTIVE=true`** 并部署，完成加密上传、解密下载与撤销分享测试。维护状态允许管理员初始化与登录，文件传输在激活后开放。

模板默认应用存储配额为 **9 GB**，单文件上限为 **8 GiB**。这两项属于应用配置；Cloudflare 账户额度与账单另行计算。

也可按[部署文档](docs/v3-deployment.md)准备本机配置后，运行 `npm run deploy:bootstrap -- --config .parcel-v3/deploy.json`。先在维护状态完成管理员绑定，再加 `--activate` 部署激活。

## 分享与接收须知

| 事项 | 使用方式 |
| --- | --- |
| **本机存储空间** | 接收时先缓存密文，再保存解密文件，通常需要约两倍文件大小的空间并预留余量。浏览器配额、无痕模式与可用磁盘空间会影响容量；保存期间保持页面打开。 |
| **断点续传** | 保留网站数据，以保存上传密钥与已接收的完整密文块。上传续传还需重新选择原文件；会话过期或浏览器缓存被清理后，可能需要重新发起传输。 |
| **下载次数** | 统计获准传输的资格，不等同于成功保存次数或独立人数。同一有效会话内的重试、续传和签名地址续签不重复扣次；传输中断不退还已消耗的资格。 |
| **撤销与到期** | 停止发放新下载资格。已签发地址在有效期内仍可使用，已取得的文件、密钥与密文副本无法收回；清理任务会等待已签发访问失效后删除对象。 |
| **密钥备份** | 将本机分享密钥导出为加密 JSON，使用独立的 12–256 UTF-8 字节口令，妥善保管备份与口令。可用密钥、完整链接与备份全部丢失后，服务端无法恢复文件。 |

## 更新已有实例

已完成配置并验证自定义域名的正式 Worker，按[更新说明](docs/v3-deployment.md)准备 `PARCEL_WORKER_BUILD_CONFIG` 后执行：

```bash
npm run build:production
npm run deploy:production
```

部署会先应用未完成的 D1 迁移，再发布 Worker，保留现有运行时变量、长期 Secrets 与管理员绑定。为恢复准备兼容的 Worker 版本，以及配套的 D1/R2 备份。

从旧版未加密部署升级时，请用原文件重新上传，生成新的加密分享。现有迁移不会自动加密或清空旧对象。加密分享需要兼容的 Worker，独立 Go 应用不能提供这类文件的下载。

## 开发与验证

Cloudflare 部署使用 React + TypeScript、Workers、D1 与私有 R2。在仓库根目录，使用 Node.js 24 和 Bash 执行：

```bash
npm run build
npm run test:crypto
npm run test:v3
npm --prefix cloudflare run test:browser:v3
PARCEL_LOGIN_WEB_DIR="$PWD/dist/v3-web" node --test web/tests/login-response.mjs
npm run test:e2ee:https
```

浏览器测试需要安装 Playwright 浏览器。真实 HTTPS 套件运行于 Linux，并依赖 OpenSSL 和 NSS `certutil`；环境准备与可选大文件验收见[协议验收说明](docs/e2ee-protocol.md#acceptance)。上线时还需验证实际部署中的 R2 CORS、签名请求与文件传输。

仓库同时保留采用原有协议的独立 Go/SQLite 应用，其构建与测试步骤见[运维文档](docs/operations.md)。本页介绍的 TOTP 与文件端到端加密功能适用于 Cloudflare 部署。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [中文图文教程](https://parcelwiki.pages.dev/zh) · [English guide](https://parcelwiki.pages.dev/) | 从创建应用到上线验证，附配置工具与常见问题。 |
| [部署与维护](docs/v3-deployment.md) | Secrets、CORS、管理员恢复、更新与备份。 |
| [加密协议](docs/e2ee-protocol.md) | 文件格式、密钥派生、信任模型与验收测试。 |
| [验收状态](docs/v3-plan.md) | 已验证的行为与各项检查的适用范围。 |
| [安全策略](SECURITY.md) | 安全漏洞的私密报告方式。 |

## 参与贡献

欢迎提交 Issue 与 Pull Request。请说明希望改进的行为，附上相关验证结果；涉及界面调整时，提供截图。凭据、完整分享链接、私有文件和数据库快照请勿放入公开报告。

## 许可证

[MIT](LICENSE)。自由部署，自由修改，搭建属于你的文件分享站。
