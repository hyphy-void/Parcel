# Parcel v0.1 安装与运维

> 适用范围：本文件是独立 Go/SQLite 兼容程序的维护资料或历史记录，不描述当前 Cloudflare V3。当前密码 + TOTP、文件端到端加密及部署操作见 [V3 部署说明](v3-deployment.md)；不要据此推断 Go 已具备这些功能。

本服务支持可信局域网部署，以及通过 Caddy 提供公网 HTTPS 分享。下文局域网示例是 Pi4B、64 位 Ubuntu、SSD 上的 ext4 根分区、IPv4 `192.168.5.16/24`；公网部署见[公网部署说明](public-deployment.md)。

## 1. 构建与初始化

从仓库根目录运行：

```bash
./scripts/build.sh
./bin/parcel admin-password
./bin/parcel serve
```

交互密码至少 8 字节。自动化初始化可用 `admin-password --password-stdin` 从标准输入读取；不要把真实密码写在命令行参数或提交到仓库。数据默认在 `./data`，运行目录变化会改变默认数据位置，正式部署必须设置绝对路径。

管理员初始化、密码重置、离线清理和运行服务共享数据目录独占锁，因此维护命令执行前要停止服务。重复服务不能同时写入同一个数据目录。

## 2. systemd 安装

```bash
sudo ./scripts/install-systemd.sh
sudoedit /etc/parcel/parcel.env
```

安装脚本创建专用 `parcel` 用户，将程序放入 `/opt/parcel/parcel`，保留已有配置；不自动启动服务，不设置管理员密码，不修改防火墙。升级现有程序前必须停止服务，会保留 `/opt/parcel/parcel.previous`。

按当前样例配置初始化：

```bash
sudo -u parcel env PARCEL_DATA_DIR=/srv/parcel PARCEL_REQUIRED_MOUNT=/ /opt/parcel/parcel admin-password
sudo systemctl enable --now parcel
sudo systemctl status parcel
curl -fsS http://192.168.5.16:8080/readyz
```

如果改变 `PARCEL_DATA_DIR` 或挂载点，初始化命令也要使用对应值，且需更新 unit 中 `ReadWritePaths` 与 `RequiresMountsFor`。当前 Pi 从 SSD 的根分区启动，所以实际挂载点为 `/`；如果独立数据盘挂载在 `/mnt/parcel-ssd`，将 `PARCEL_REQUIRED_MOUNT` 设置为那个真实挂载点。该配置会在创建数据目录前检查挂载，并在写入/清理前复查，防止磁盘未挂载时落到其他分区。

如果 UFW 已启用、LAN 网段确为示例中的 `/24`，可只开放该网段：

```bash
sudo ufw allow from 192.168.5.0/24 to 192.168.5.16 port 8080 proto tcp comment 'Parcel LAN'
```

保持现有 SSH 规则。服务绑定明确的内网 IPv4，不会自动监听公网 IPv6。用路由器 DHCP 保留固定地址，不需要公网端口转发。

## 3. 配置

完整样例见 [parcel.env.example](../deploy/parcel.env.example)。数字大小使用字节，时长使用 Go 时长语法，如 `30m`、`24h`、`168h`。

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `PARCEL_LISTEN_ADDR` | `127.0.0.1:8080` | 明确绑定的内网或回环地址 |
| `PARCEL_BASE_URL` | `http://127.0.0.1:8080` | 唯一页面/API origin，用于链接、Host/Origin 校验 |
| `PARCEL_TRUSTED_PROXIES` | 空 | 逗号分隔的代理 CIDR；默认忽略代理头，仅受信任连接的 X-Forwarded-For 用于客户端 IP 限流 |
| `PARCEL_STORAGE_BACKEND` | `local` | 新上传存储后端；可设为 `r2`，已有本地记录保留 |
| `PARCEL_R2_ENDPOINT` | 空 | R2 S3 HTTPS origin，不包含桶名 |
| `PARCEL_R2_BUCKET` | 空 | 私有桶名 |
| `PARCEL_R2_CREDENTIALS_FILE` | 空 | 0600 的服务用户凭据文件 |
| `PARCEL_R2_STORAGE_QUOTA_BYTES` | 9 GB（9,000,000,000 字节） | R2 对象、上传与临时预留的独立保护上限；不足时拒绝新上传 |
| `PARCEL_DATA_DIR` | `./data` | DB、临时文件及最终文件目录 |
| `PARCEL_REQUIRED_MOUNT` | 空 | 正式部署应指定真实挂载点 |
| `PARCEL_MAX_FILE_BYTES` | 8 GiB | 单文件上限，大小/偏移采用 64 位 |
| `PARCEL_STORAGE_QUOTA_BYTES` | 20 GiB | 已存文件与完整上传预留的合计上限 |
| `PARCEL_MIN_FREE_BYTES` | 2 GiB | 物理磁盘保留余量 |
| `PARCEL_UPLOAD_CHUNK_BYTES` | 8 MiB | 单个 PATCH 的实际请求体上限 |
| `PARCEL_UPLOAD_IDLE_TTL` | `24h` | 未完成上传的无活动回收时间 |
| `PARCEL_DEFAULT_SHARE_TTL` | `24h` | 默认分享时长，从发布成功起算 |
| `PARCEL_MAX_SHARE_TTL` | `168h` | 最长分享时长 |
| `PARCEL_DEFAULT_DOWNLOAD_LIMIT` | 3 | 下载资格上限，允许 1–100 |
| `PARCEL_DOWNLOAD_IDLE_TTL` | `30m` | 已启用会话的空闲失效时长 |
| `PARCEL_DOWNLOAD_MAX_TTL` | `8h` | 会话绝对上限；本地流也受其限制，R2 地址另为 5 分钟 |
| `PARCEL_CLEANUP_INTERVAL` | `60s` | 清理与 WAL checkpoint 周期 |
| `PARCEL_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `GOMEMLIMIT` | Go 默认 | systemd 样例设 `192MiB`，是 GC 软目标 |

请求正文默认最多读取 15 秒，包括鉴权或来源拒绝后的正文收尾；JSON 超时返回 HTTP 408。已通过检查的本地上传 PATCH 使用独立的两分钟正文期限，大文件下载仍使用自己的流超时。

本地传输的单实例固定限制为 2 个上传分块请求、4 个文件下载流、1 个文件哈希校验任务、2 个密码哈希任务；未完成上传最多 100 个。修改配置后重启服务。HTTPS BASE_URL 会启用 Secure Cookie，v0.1 程序本身提供 HTTP，HTTPS 部署须另行提供同源 TLS 终止并保持 Host/Origin。

## 4. 文件生命周期与下载

以下描述本地存储路径；R2 的单分块 / Multipart 核验、5 分钟地址和授权时计数见 [R2 存储说明](r2-storage.md)。

文件经过完整字节数验证与流式 SHA-256 校验后才发布。发布前的请求不会生成可用分享。上传回复丢失时应查询 upload offset，再发下一块；刷新页面可重新选择原文件继续。重新选择文件的名称、大小和修改时间只作辅助检查，内容是否一致由上传者保证。

下载票据初始 10 分钟有效，不扣资格。首次 `200/206` 内容响应前事务内扣一次并启用会话，同一票据的后续 Range 与重试不再扣。`HEAD`、`304`、`416`、鉴权失败和繁忙响应不扣次数。资格启用后断线不退款，可在会话有效期内重试。票据持有者可复用凭证，次数不代表不同的人。

到期或撤销立即阻止新请求；到期前已开始的流可在最长会话期限内完成。撤销或改密码尽力取消活动流、作废旧授权。次数耗尽后保留已有有效会话的续传资格，等会话失效且无活动流再物理删除。

新建分享可勾选“不限下载次数”，有效期、密码保护和撤销照常生效，下载统计仍持续累计。API 使用 `max_downloads=-1`；`1–100` 为有限次数，省略或传 `0` 仍使用默认值，不需要调整 `PARCEL_DEFAULT_DOWNLOAD_LIMIT`。Go 启动时自动升级至 schema 4，升级前须停机备份完整数据目录；旧版二进制不支持 schema 4，不能只回退二进制。D1 使用独立迁移并由生产部署脚本在发布 Worker 前应用，见 [V3 部署说明](v3-deployment.md)。

网页不会报告浏览器已落盘成功，也无法可靠检测原生下载中途失败；下载列表由浏览器管理。已准备过下载的接收页可以复用当前票据，刷新页面会丢失页面内票据。下载地址是授权凭证，不应再转发或收集到访问日志中。

## 5. 日志、空间与故障

```bash
sudo journalctl -u parcel -n 100 --no-pager
sudo journalctl -u parcel -f
sudo systemctl restart parcel
```

日志不包含密码、Cookie 和真实下载票据路径；debug 记录的是路由模板。管理页区分已用、上传预留、待清理和物理空闲。删除失败会保留占用并退避重试，文件删除成功之前不会释放配额。

| 现象 | 处理 |
| --- | --- |
| `host_denied` / `origin_denied` | 用与 BASE_URL 完全匹配的地址访问；IP 改变后更新 LISTEN_ADDR、BASE_URL 及防火墙 |
| 登录未初始化 | 停止服务，在相同 DATA_DIR 初始化管理员密码 |
| `insufficient_storage` / `chunk_failed` | 检查磁盘与配额，清理后查询上传 offset，再继续；失败分块不确认偏移 |
| 上传中断 | 在新建分享页面选择同一个原文件；保留的确认位置可续传 |
| 文件校验中重启 | 启动自动重新校验 finalizing 上传；最终文件已移动时也可恢复发布 |
| 数据目录被占用 | 确認没有另一服务或维护命令使用同一目录 |
| `missing` / 文件不可用 | 检查磁盘文件是否丢失；服务不会伪造成功下载，需重新上传 |
| 主机可打开但手机打不开 | 检查 LAN 网段、UFW、访客 Wi-Fi 客户端隔离；不能用公网或移动网络访问内网地址 |

临时分享默认不做自动长期备份。需要升级前的短期一致性快照时，先停止服务，再备份整个数据目录。运行中的 WAL 数据库不能只复制单个 `.db` 文件。备份副本包含文件内容，不受在线自动到期清理控制，由管理员及时销毁。

## 6. 升级、回滚与恢复

```bash
sudo systemctl stop parcel
sudo ./scripts/install-systemd.sh
sudo systemctl start parcel
```

安装会保留上一程序；回滚时停止服务，再用 `/opt/parcel/parcel.previous` 恢复。v0.1 的 schema migration 版本是 1，启动会拒绝未知版本。未来出现不可向后兼容的 migration 时需同时恢复升级前的一致性数据快照，不能仅回滚二进制。

启动自动校对上传尾部、finalizing 状态、缺失文件和删除状态；无引用残留文件经过一小时保护窗口回收。分享删除 tombstone、清理后的上传与审计记录保留 7 天，审计还限制为约 10000 条。任何应用“删除”都不承诺对 SSD 做不可恢复的擦除。

## 7. 验收命令

```bash
npm --prefix web run build
go test -race ./...
go vet ./...
python3 scripts/acceptance.py
python3 scripts/storage-acceptance.py
cd web
npx playwright install chromium firefox
npm run test:e2e
```

大文件脚本使用独立回环端口和临时目录，不操作线上数据；默认实写 8 GiB 输入、上传文件与下载输出，并用 SIGKILL 测试恢复。磁盘脚本只创建一个独立的临时 ext4 loop 文件系统，结束时卸载，验证实际 ENOSPC 与卸载后拒绝启动。两者会把结果记录到 `docs/*acceptance-results.json`。

浏览器测试使用一次性管理员密码与独立数据目录。移动端 Chromium 项目是设备模拟，不能替代真实手机与外部 LAN 设备的验收，实测范围见 [验收报告](acceptance.md)。

## 8. CI 发布与树莓派升级

日常 push/PR 会运行 CI；正式发布使用 `vX.Y.Z` tag。发布工作流先执行前端构建、Go race/vet、升级工具测试和三项目浏览器测试，再交叉编译 ARM64、ARMv7、AMD64。所有资产上传至草稿 Release 后才公开，失败的测试不会发布。只接受正式版本，不发布 `-rc` 等预发行 tag。

```bash
# 在开发电脑上，先提交并推送经过审查的代码；版本号按实际发布修改。
git tag -a v0.1.1 -m 'Parcel v0.1.1'
git push origin v0.1.1
```

发布页包含 `parcel-linux-arm64`、`parcel-linux-arm`、`parcel-linux-amd64`、`release.json` 和 `SHA256SUMS`。schema 元数据必须与 `internal/parcel/app.go` 支持的数据库版本保持一致。现有 CI 仍提供 `parcel-linux` artifact；Release 则提供固定版本下载地址。CI 只构建一次前端，不再重复 npm 安装或为发布额外构建宿主程序。

### 首次用预编译产物安装

树莓派只需要 Python 3.9+、curl、systemd 和 util-linux 的 flock，不需要 Go/Node。下面以 64 位 Ubuntu 和 `v0.1.1` 为例；先确认该版本已经发布。32 位 ARMv7 系统将文件名改为 `parcel-linux-arm`，不支持 ARMv6。

```bash
# 在已有仓库目录中执行；这里只下载，不编译。
mkdir -p bin dist
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/hyphy-void/Parcel/releases/download/v0.1.1/parcel-linux-arm64 \
  -o dist/parcel-linux-arm64
curl -fL --proto '=https' --proto-redir '=https' \
  https://github.com/hyphy-void/Parcel/releases/download/v0.1.1/SHA256SUMS \
  -o dist/SHA256SUMS
(cd dist && sha256sum --check --ignore-missing SHA256SUMS)
install -m 0755 dist/parcel-linux-arm64 bin/parcel
sudo ./scripts/install-systemd.sh
```

之后按第 2 节配置数据路径、初始化密码并启动服务。已有部署首次安装新版升级工具时，停止服务、执行安装脚本、再启动即可。安装脚本会保留已有 `parcel.env` 和 `update.env`，安装定时器但不会启用。

### 一键升级

```bash
# 检查最新正式版本，不安装。
sudo /usr/local/lib/parcel/update.py --check
# 推荐指定版本，可重现升级结果。
sudo /usr/local/lib/parcel/update.py --version v0.1.1
# 或选择最新正式版。
sudo /usr/local/lib/parcel/update.py
```

升级工具从固定的 GitHub 仓库读取版本，按用户空间位数选择架构，下载并校验二进制与 schema 元数据，还会检查二进制报告的版本。下载、校验和兼容性检查期间服务保持运行；全部通过后才停止服务、在同一文件系统原子替换程序并启动。确认 systemd 服务处于 active 且 `/readyz` 返回 `status=ready` 后才报告成功。

上一程序保留为 `/opt/parcel/parcel.previous`。新程序启动失败或健康检查失败会恢复上一程序并再次验证；回滚失败返回非零退出状态，需查看日志。SIGINT/SIGTERM 会进入同一恢复流程；断电或 SIGKILL 无法执行恢复代码，可按第 6 节手动恢复。安装与升级共用文件锁，避免并发替换。

升级期间会短暂中断传输，可通过项目已有的续传机制恢复。工具不修改配置、密码或分享文件，也不创建整盘数据快照。**schema 不同的发布会拒绝安装**，须停止服务、备份整个数据目录后手动迁移；二进制回滚不能替代数据恢复。当前 schema 为 3（生产已升级）；从 schema 1 或 2 升级需按 [R2 迁移流程](r2-storage.md) 停机备份并手动安装，发布者应保持同 schema 下的数据兼容性。

默认健康检查使用 `PARCEL_BASE_URL/readyz`；有代理等情况可在 `/etc/parcel/update.env` 设置 `PARCEL_HEALTH_URL`，该地址应直达同一服务，并符合应用 Host 校验。配置按字面量 `KEY=value` 读取，不执行 shell；空格需引号，不支持变量展开。自动升级依赖公开 GitHub Release 下载；私有仓库资产下载不在本工具支持范围内。API 限流时可手动运行 `sudo --preserve-env=GH_TOKEN ...`，令牌仅发送到 GitHub API。

### 可选定时更新

```bash
sudoedit /etc/parcel/update.env
# 将 PARCEL_AUTO_UPDATE=false 改成 true，再启用定时器。
sudo systemctl enable --now parcel-update.timer
sudo systemctl list-timers parcel-update.timer
# 可以立即触发一次检查。
sudo systemctl start parcel-update.service
sudo journalctl -u parcel-update.service -n 50 --no-pager
```

每天北京时间 04:00 起随机延迟最多 30 分钟检查；错过的检查会在开机后补做。只有明确开启 `PARCEL_AUTO_UPDATE=true` 才安装，并仅接受当前 `X.Y` 内更高的补丁版本。同版本不下载、不重启；新主/次版本、降级或开发版不会自动安装。若 GitHub latest 已跨次版本，则跳过，并在日志中提示手动处理，不再搜索旧分支的补丁版本。

```bash
# 关闭定时任务；也可把配置改回 false。
sudo systemctl disable --now parcel-update.timer
```

检查和升级结果写入 systemd journal；网络、校验、启动或回滚失败使 oneshot 服务失败，后续定时检查可重试。这里没有接入外部消息通知。GitHub 云端只构建和发布，树莓派主动下载，因此无需让 GitHub runner 连接内网或在树莓派上运行构建 runner。

## R2 存储

新增私有 R2 配置、CORS、单分块上传、历史单次 PUT 和 Multipart 恢复、9 GB 存储保护、下载会话与跨 schema 回滚流程见 [r2-storage.md](r2-storage.md)。本地存储为默认值，历史文件继续使用本地下载。

## 当前 Cloudflare 部署

当前线上使用 Workers + D1 + 私有 R2，管理员密码 + TOTP 与浏览器端到端加密的部署、更新和恢复统一见 [v3-deployment.md](v3-deployment.md)。本文件的二进制、systemd、SQLite 及本地密码初始化步骤只适用于独立 Go 兼容程序。
