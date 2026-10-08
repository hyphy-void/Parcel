# 私有 R2 直传与下载

Parcel 使用树莓派鉴权、SQLite 元数据和私有 R2 对象存储。网页与 API 仍走 Cloudflare Tunnel → Caddy → Parcel；文件字节通过 R2 S3 API 预签名地址在浏览器和 R2 之间传输，不经过 Pi，不需要 Worker、公开桶、r2.dev 或自定义下载域名。

## 配置

在现有 `/etc/parcel/parcel.env` 中追加（保留现有其他设置）：

```ini
PARCEL_STORAGE_BACKEND=r2
PARCEL_R2_ENDPOINT=https://15cfc46fe23bf82055e97614de76b744.r2.cloudflarestorage.com
PARCEL_R2_BUCKET=parcel
PARCEL_R2_CREDENTIALS_FILE=/etc/parcel/r2.credentials
PARCEL_R2_STORAGE_QUOTA_BYTES=9000000000
```

Endpoint 是不带桶名、路径或末尾斜杠的 HTTPS origin；桶名单独填写。默认 `local`，启用 R2 后只改变新上传，旧文件和进行中的本地上传仍使用原有路径。数据库存在未清理的 R2 记录时，启动必须保留 R2 配置，避免误报文件丢失或泄漏对象。

凭据文件格式（示例值不是实际凭据）：

```ini
ACCESS_KEY_ID=replace-me
SECRET_ACCESS_KEY=replace-me
```

也支持 `Access Key ID:` / `Secret Access Key:` 标签后同一行或下一行的原始配置文件格式。文件必须为普通文件，权限 `0600`，由 systemd 服务用户持有；不要打印文件、放到命令参数、前端构建变量或 Git。凭据需为 **Object Read & Write，仅授权 parcel 桶**；应用没有读取/修改桶策略的需求。SDK 错误经过过滤，不记录预签名地址或密钥。预签名地址和下载会话也是短期授权凭证，不应加入访问日志或分析工具。

R2 桶选择 APAC、Standard；关闭公共开发 URL 和公开自定义域。保留桶内已启用的未完成 Multipart 中止生命周期规则（2026-10-09 控制台显示 **1 天后中止**），兜底清理“R2 已创建任务但进程在写入任务 ID 前崩溃”的孤立任务。Parcel 对有记录的取消/过期任务主动中止并删除，失败时继续占用配额、定期重试。生命周期规则不能代替 Parcel 的上传任务清理。

在 Cloudflare Dashboard → R2 → parcel → 设置 → CORS 策略中使用 [deploy/r2-cors.json](../deploy/r2-cors.json)。仅允许 `https://parcel.playereconlab.com`；允许 GET、HEAD、PUT，请求头 Content-Type、Range、X-Amz-Meta-Parcel-Upload，暴露 ETag 等响应头。不要把 Origin 设为 `*`。本地开发直传需显式添加开发 origin（例如 `http://127.0.0.1:5173`）；正式配置不包含开发 origin。CORS 不是桶的访问授权，签名和私有桶仍然必须保留。

**2026-10-09 已将生产桶更新为上述 CORS 策略，允许单次 PUT 的任务元数据请求头。真实 OPTIONS 预检及对象读写验证通过；仍只允许生产 Origin，桶保持私有。**

## 上传、核验与恢复

- 确认阈值为十进制 **100 MB = 100,000,000 字节**。不超过该值无需二次确认；超过时弹出确认框，后端也要求 `confirm_large: true`。硬上限独立保留，默认 **8 GiB = 8,589,934,592 字节**。
- 新任务不超过 100 MB 时使用单次预签名 PUT，包括空文件；更大文件使用 16 MiB Multipart，末块可更小。历史 Multipart 任务继续原有方案，不会因升级切换。PUT 地址有效 5 分钟，Content-Length 纳入签名；单次 PUT 还签名任务元数据请求头。
- 单次 PUT 调用管理员 API `POST /api/v1/uploads/{id}/object` 取得地址和请求头，浏览器发送完整文件。中断后需重新发送整个文件；GET 上传任务通过 R2 HEAD 判断完整对象是否已存在，已上传成功的文件可以直接继续发布，不必重传。
- Multipart 的 `GET /api/v1/uploads/{id}` 查询 R2 ListParts，返回已完成分块和连续已确认偏移。浏览器从该位置恢复，失败时指数退避、重新签发地址（每次最多重试 3 次）；暂停后可继续，刷新后重新选择原文件。原文件匹配检查沿用名称、大小及修改时间。
- `POST /api/v1/uploads/{id}/parts/{part}` 只供已登录管理员、通过 CSRF 检查的未完成 Multipart 任务使用。R2 上传拒绝原来的 PATCH 文件内容路径；历史本地上传继续使用 PATCH。
- 单次 PUT 写入临时对象；后端 HEAD 核对大小、任务标识和 ETag，再以该 ETag 为条件在 R2 内部复制到分享对象，最后 HEAD 核验并提交 SQLite。浏览器没有分享对象的 PUT 地址，旧上传地址无法覆盖已发布文件。临时对象在上传地址到期后清理，删除失败继续保留配额并重试。复制期间文件内容也不经过 Pi。
- Multipart 完成时后端再次 ListParts，严格检查分块编号、数量、尺寸与 ETag，以 R2 返回的 ETag 完成 Multipart；HEAD 再核对对象总大小、服务端写入的上传任务标识及 ETag，然后在 SQLite 事务中开放分享。前端不提交“上传成功”证明或决定完成分块列表。
- R2 已完成但 SQLite 未提交时，重启根据 HEAD 和任务标识恢复发布；R2 暂时失败保留 finalizing 和配额，查询任务会触发间隔至少 30 秒的发布重试。取消和清理不会与同一任务的签发/完成并发。单次 PUT 取消后仍保留预留，待已签发地址过期并删除对象后释放。
- 创建任务先预留完整文件配额。Pi 的磁盘只保留 SQLite 和旧本地文件；R2 上传不按文件大小扣本地磁盘预留，但仍检查本地最小剩余空间。全局逻辑配额统计本地与 R2 的对象及未完成任务；R2 独立保护额度另见下节。
- R2 ETag 是对象标识，**不是 SHA-256**，Multipart 尤其不能作为 SHA-256 使用。R2 分享的 sha256 留空、页面显示 R2 ETag；本地分享仍计算/显示 SHA-256。本次核验提供服务端任务绑定及尺寸核验，不声称具备文件内容的端到端 SHA-256 校验。传输使用 HTTPS，分块/完成由 R2 处理。

## R2 存储额度与分享记录

`PARCEL_R2_STORAGE_QUOTA_BYTES` 默认为 **9 GB = 9,000,000,000 字节**，独立于默认 20 GiB 的全局逻辑配额。管理员页面显示已存用量、上传及临时预留、剩余空间和保护上限。后端在创建任务时原子检查容量：不足返回 HTTP 507 / `r2_quota_exceeded`，不创建新上传；已有预留的任务仍可完成。

用量包含尚未物理删除的 R2 分享，预留包含未完成上传。单次 PUT 为临时对象与发布副本预留两倍文件大小，完成后临时对象占用继续保留直到清理成功；Multipart 预留一倍文件大小。本地文件不占 R2 保护额度。删除失败、取消任务仍有有效 PUT 地址等情况不会提前释放空间。

这项保护按 **Parcel 管理的对象和任务**计量，不查询 Cloudflare 全账户账单，也不统计其他桶、桶内外部写入的对象或月度请求额度。Cloudflare Standard 免费档为每月 10 GB·月存储、100 万次 Class A 和 1000 万次 Class B 操作；存储账单按每日峰值的月平均计算，超过免费档会计费，并非自动停止。9 GB 上限不能保证整个账户零费用，月度用量仍以 [Cloudflare 账单与定价说明](https://developers.cloudflare.com/r2/pricing/)为准。

分享记录的刷新按钮旁新增“清除已清理”。确认后管理员 API `DELETE /api/v1/admin/shares/cleaned` 仅删除状态为 `deleted` 的历史记录及其授权会话；仍可下载、已失效但尚未物理清理的分享均保留。上传任务记录继续用于临时对象清理和恢复，清除历史不会释放尚未清理的存储空间。

## 下载授权与计数

`POST /api/v1/shares/{id}/download-sessions` 校验分享密码授权、状态、期限和下载次数。R2 签名成功后，在一个事务中建立 active 会话并消耗一次资格；返回 `url`、`session`、`expires`（地址期限）、`session_expires`（会话最长期限）。签名失败不扣次数。

GET 地址有效期固定为 **5 分钟**，包含 attachment 文件名、application/octet-stream 及 private/no-store 响应覆盖。R2 支持 Range；有效地址可多次请求，计数语义是授权会话，不是 HTTP 请求数。地址到期限制新请求，不应理解为立即终止已开始的下载。

续签使用：

```http
POST /api/v1/shares/{id}/download-sessions/refresh
Content-Type: application/json

{"session":"previous-session-token"}
```

后端检查会话所属分享、版本、状态、分享期限、会话绝对期限和空闲期限，通过后续签，不再扣次数。会话最长 8 小时、空闲 30 分钟（沿用原配置）；页面在同一标签页 sessionStorage 保存 R2 会话，刷新和“再次下载 / 继续”复用。撤销、改密码或分享到期后立即停止签发；已签发的 URL 仍可在它的 5 分钟内发起请求。浏览器不会用 HEAD 检查一个按 GET 签名的地址。

下载管理器可在地址过期后换取新 URL，并保持已下载偏移发起 Range；原生浏览器下载列表的续传使用旧地址时可能失败，需要从分享页重新获取。点击“再次下载”启动浏览器原生下载；应用不接管下载文件落盘或自动合并浏览器下载列表中的中断任务。

R2 内容流不经过 Parcel，无法从服务器观察活跃传输。为避免过早删除影响已开始的下载，数据库 `signed_until` 保存已授权会话的最长绝对期限（至少覆盖 URL 期限）；撤销、到期或次数耗尽的对象在这个保留期限后才物理删除。保留期间继续计入用量；页面权限立即失效。删除失败有退避并保留配额，成功后释放。若需立即删除对象，应明确接受对已开始下载的影响。

## 迁移与生产安装

当前本地版本支持 schema **3**，逐次事务迁移 schema 1 → 2 → 3，拒绝更高版本。首次 R2 迁移将旧记录标为 local，无需迁移已有文件；本次 2 → 3 增加单次 PUT 地址期限和临时对象清理状态。生产已于 2026-10-09 升级到 schema 3。跨 schema 回滚须恢复升级前的一致性数据，不能仅回滚二进制。

1. 本地执行构建和验证，`./scripts/release.sh --skip-web` 产生 ARM64 等产物、schema 3 元数据和 SHA256SUMS。现有自动 updater 拒绝跨 schema 升级，第一次必须手动维护。
2. 用 Tailscale SSH 检查远端 `git status --short` 和修改差异，检查 systemd 服务用户、现有配置及数据目录。保留远端修改，不 reset。只同步必要源码或经核验二进制。
3. 将产物传到远端仓库 `bin/parcel.next`，比较本地/远端 SHA-256。安全安装凭据到 `/etc/parcel/r2.credentials`，服务用户拥有、0600；保留 `/etc/parcel/` 的其他配置。
4. 停止 parcel，备份旧二进制、配置，以及**停止状态下 parcel.db、parcel.db-wal、parcel.db-shm（如存在）的一致性副本**。保留所有本地 files/tmp 和 `/srv/parcel` 数据。备份保存在数据目录之外的受限目录；空间允许时备份完整数据目录。
5. 安装已校验产物到 `/opt/parcel/parcel`，追加 R2 配置，启动。验证 `systemctl is-active parcel`、本地 `/readyz`（使用配置的 BASE_URL Host；公网 Caddy 阻止 readiness）及公网登录/分享。readiness 检查本地元数据存储，不替代真实 R2 上传下载验收。
6. 用独立测试分享检查 >100 MB 确认、直传、密码、Range、续签次数、撤销与清理；浏览器 Network 必须显示文件 PUT/GET 指向 R2，Parcel 请求仅含元数据。
7. 失败则停止服务，恢复升级前数据库一致性副本、原配置和旧二进制，再启动验证。维护验收前不要允许真实新上传；否则回退数据库会丢失升级后的新元数据，需要先保全并清点 R2 对象，不能盲目覆盖。

首次跨 schema 部署须按 [operations.md](operations.md) 和 [tunnel-deployment.md](tunnel-deployment.md) 执行；2026-10-08 的生产安装记录见下文。

## 验证命令

```bash
./scripts/build.sh
go test -race ./...
go vet ./...
npm --prefix web run typecheck
(cd web && npx playwright install chromium firefox && npm run test:e2e)
PARCEL_TEST_BINARY="$PWD/bin/parcel" python3 -m unittest discover -s scripts/tests -v
./scripts/release.sh --skip-web
```

真实 R2 冒烟测试（仅创建/清理随机 `parcel/probe/` 测试对象，不打印凭据或签名地址）：

```bash
PARCEL_R2_LIVE_CREDENTIALS="$PWD/.parcel-secrets/r2.credentials" \
PARCEL_R2_LIVE_ENDPOINT=https://15cfc46fe23bf82055e97614de76b744.r2.cloudflarestorage.com \
PARCEL_R2_LIVE_BUCKET=parcel \
go test -count=1 -run 'TestLiveR2|TestLiveSinglePut' -v ./internal/r2
```

核对 API 权限是否仅限该桶仍需在 Cloudflare 控制台检查；成功的对象读写测试不证明其他桶不可访问。Object Read & Write 不应扩大成 Admin Read & Write，仅为修改 CORS 而升权没有必要。

参考：[预签名地址](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[上传与 Multipart 限制](https://developers.cloudflare.com/r2/objects/upload-objects/)、[CORS](https://developers.cloudflare.com/r2/buckets/cors/)。

## 2026-10-08 开发验收

开发机器真实 R2 验证通过：两个分块（16 MiB + 1 KiB）的直传、ListParts、完成、HEAD 大小/任务标识、GET Range 和中文 attachment 文件名、零字节文件、Multipart 中止及删除后 HEAD 不存在。更新后的凭据具有实测对象读写能力，桶设置 API 返回 AccessDenied，未扩大到管理员权限。

控制台确认 APAC、Standard、无公开自定义域且 r2.dev 关闭；原有默认 7 天 Multipart 中止规则保持启用。已配置仅生产 origin 的 CORS，并真实验证 PUT CORS、暴露 ETag 和 OPTIONS 预检。凭据管理页也确认活动账户令牌仅应用于 parcel 桶，权限为对象读和写。以上为开发阶段验收；随后进行了下文记录的 Pi 生产安装。

本地完整构建、Go race/vet、TypeScript、45 项浏览器用例（Chromium、Firefox、移动 Chromium）及 19 项 updater 测试通过。已生成 ARM64、ARMv7、AMD64 发布产物，SHA256SUMS 校验通过；ARM64 产物随后在 Pi 上完成实际运行验收。

## 2026-10-08 树莓派生产部署

已在开发机器完成 ARM64 交叉编译，并安装到 Pi 的 `/opt/parcel/parcel`。安装前、传输后与安装后 SHA-256 一致：

```text
3631b3b60d05f46e47ed3d81f0f3de2d8202ee4643c5ed95f8bd078a317e67fe
```

生产启用 `PARCEL_STORAGE_BACKEND=r2`，Endpoint 与 Bucket 分开配置。凭据安装到 `/etc/parcel/r2.credentials`，属主 `parcel:parcel`、权限 0600；配置目录为 `root:parcel`、0750，供受 systemd 沙箱限制的服务读取。管理员密码和其余配置保留。数据库已从 schema 1 升级到 2，SQLite `quick_check` 通过；旧本地文件 SHA-256 与停机备份一致，原有两个活动本地分享保持 local。

生产实际验收通过：管理员权限与 CSRF、100,000,000 字节确认阈值和硬上限、配额预留、16 MiB + 1 KiB Multipart 直传、生产 Origin CORS/ETag、ListParts 恢复、不完整上传拒绝完成、服务端完成和 HEAD 验证、分享密码、5 分钟 GET、文件名与 Range、单会话一次计数、续签不重复扣次数、撤销后拒绝新签名且旧签名仍可用。已验证取消 Multipart 清理、R2 对象物理删除和配额释放；仅对生成的已撤销测试分享临时清零保留期限，以立即验收删除。测试对象、测试元数据和短期管理员会话均已清理。

升级期间 Caddy 临时阻止公网 `/api/*` 写入，验收通过后恢复原始配置。`parcel`、`caddy`、`cloudflared` 均 active，回环 `/readyz` 正常；公网首页 HTTP 200、未登录管理 API HTTP 401，公网 readiness 仍按原路由策略 HTTP 403。生产浏览器管理页面显示“私有 R2 存储”。远端未跟踪的 `AGENTS.md`、`deploy/Caddyfile.next` 保留，未同步或重置远端源码。

完整停机数据、旧二进制、原配置及验收记录保存在 root 专用目录：

```text
/var/backups/parcel-r2-deploy-20261008-222211
```

`/opt/parcel/parcel.previous` 另保留升级前二进制。备份目录内 `rollback.py` 可恢复升级前二进制、配置和完整数据，并保全失败现场。**公网已恢复后不能直接执行数据库回退**：应先暂停写入、备份现状并清点升级后新增记录与 R2 对象，按上文迁移步骤处理，避免丢失新上传元数据。首次部署时的生产密钥暂存副本已删除，正式凭据保存在 `/etc/parcel/r2.credentials`。

## 2026-10-09 本地修正与验证

前端现在按上传任务的实际 backend 显示路径。恢复启用 R2 前的 local 任务时，会说明继续上传仍经过服务器，并提示取消后新建任务以使用 R2；不再仅凭全局配置标注直传。R2 已保存的分块与服务端完成/HEAD 发布确认分别展示，完成阶段说明为“正在完成 R2 上传”。

发布轮询单次请求最多等待 30 秒，连续查询约 2 分钟后退出等待状态；后端已报告发布错误时立即展示错误。任务保留，并提供“查询发布结果”入口，查询不需要重新选择文件或重传。浏览器回归覆盖新建 R2 任务确实按 16 MiB PUT、断点恢复、发布超时后查询成功、发布错误提示及旧任务路径说明。用户随后确认公网当前为 16 MiB 分块，主要体验问题是上传完成后的发布确认停顿。单次 PUT 也需要服务端核验与发布确认；页面保留进度及可重查的发布状态。

本地新增 ≤100 MB 单次 PUT、9 GB 存储保护和清除已清理历史记录。完整构建、TypeScript、Go race/vet 和 66 项 Chromium/Firefox/移动浏览器测试通过；真实 R2 单次 PUT 验证覆盖空文件、任务元数据、条件复制、不可覆盖发布对象及删除。管理页截图使用独立临时数据库和生成的示例记录，未使用生产文件。

用户授权从 Pi 安全取回凭据后，开发副本保存到 `.parcel-secrets/r2.credentials`，文件 0600、目录 0700，整个目录被 Git 忽略。不要提交或打印该文件。上述是部署前的本地验证记录；用户随后授权提交、推送并部署，安装结果见下节。


## 2026-10-09 schema 3 生产部署

实现提交为 `a2cb1f1`，已推送至 `origin/main`。ARM64 产物在开发机器交叉编译，传输前、Pi 上传后和安装后的 SHA-256 一致：

```text
ca44912e97f6a2f1c894c44cbad747eb912e933bae0bbdd9829cf071e27ba50c
```

已安装到 `/opt/parcel/parcel`，显式配置 `PARCEL_R2_STORAGE_QUOTA_BYTES=9000000000`，数据库从 schema 2 事务迁移到 3，SQLite `quick_check` 正常。停机前启用临时公网 API 维护门禁；二进制、完整数据、原配置与 Caddy 配置的一致性备份保存在：

```text
/var/backups/parcel-r2-v3-20261009-002645
```

目录权限 0700，含 `deployment.json` 验收记录和 `rollback.py`。`/opt/parcel/parcel.previous` 保留此次升级前的 schema 2 二进制，更早的 schema 1 备份仍保留在首次部署备份目录。跨 schema 不能仅替换二进制回滚；恢复脚本要求公网 API 处于维护状态。恢复公网写入后，须先备份现状、保全新记录并清点 R2 对象，再评估是否恢复旧快照。

首次加载临时维护配置因文件权限导致 Caddy 拒绝读取，检查立即恢复原配置，没有替换二进制或数据库；修正为保留原文件权限后重试成功。远端源码已 fast-forward 到实现提交；原未跟踪 `AGENTS.md` 与新仓库版本内容一致，先备份再恢复原件，`deploy/Caddyfile.next` 保持未跟踪且未修改。用户另行要求终止的 128,878,726 字节未完成 Multipart 已通过管理员取消接口终止，清理状态为 `cleaned`，残留与配额释放成功。

生产桶已按 `deploy/r2-cors.json` 更新 CORS，允许任务元数据请求头；仍限定生产 Origin，APAC、Standard 和私有访问保持不变。此次控制台显示已有生命周期规则为 1 天后中止未完成 Multipart，保持其现有设置。

生产实际验证通过：鉴权与 CSRF、>100 MB 确认、≤100 MB 单次 PUT、元数据请求头 OPTIONS、HEAD 恢复、R2 内部条件复制与发布、临时空间预留、9 GB 后端保护配置、分享密码、5 分钟 GET、文件名、Range、授权会话计数、续签不重复扣次、撤销后拒绝续签、Multipart 任务创建与取消、分享对象及临时对象清理、配额释放。仅对生成的测试分享缩短保留期限以验证删除，未调整用户分享；测试对象、记录和临时管理会话均已清理。旧本地文件 SHA-256 保持一致，公网前端静态资源与已测试的本地构建逐字节一致。

验收通过后恢复原 Caddy 配置及公网 API。`parcel`、`caddy`、`cloudflared` 均 active，回环 `/readyz` 正常；公网首页正常、未登录管理 API 返回 401，公网 readiness 仍按原路由策略返回 403。


## 2026-10-09 单次 PUT 重试问题修复

非空单次 PUT 的 SDK 预签名结果包含 `Content-Type: application/octet-stream`，并将该头纳入签名。旧前端先设置默认 Content-Type，再逐个设置签名请求头；XMLHttpRequest 会追加重复头，实际发送 `application/octet-stream, application/octet-stream`。真实 R2 返回 HTTP 403 / `SignatureDoesNotMatch`，因此发送进度虽然达到 100%，对象仍未被接受。空文件的签名头不同，不能仅以空文件验证代表非空上传。

修复将请求头交由 `Headers` 按大小写无关的名称整理，每个头仅调用一次 `setRequestHeader`。签名、权限等不可重试错误立即显示具体原因并保留任务；PUT 返回成功但 HEAD 未确认完整对象时也停止自动重传，避免无限将整文件重新发送。传输完成后仍保留服务端核验，不将发送进度当作发布成功。

此前 Go 冒烟使用 `http.Header.Set`，重复设置会替换；浏览器模拟只返回任务元数据头，遗漏了 SDK 对非空文件返回的 Content-Type，因此未覆盖真实故障。此次先补真实请求头断言，旧前端测试失败并明确捕获重复值；修复后 84 项浏览器测试通过（含 Chromium、Firefox、移动 Chromium 各自的空文件和 20 MiB 真实 R2 PUT）。真实 R2 验证还覆盖非空重复头的 403 复现，以及 93,607,928 字节整文件上传、HEAD、复制和下载一致性。Go race/vet 和构建通过。

真实浏览器探针只写入随机 `parcel/probe/browser-probe-*` 对象，权限与 CORS 使用真实生产桶；网页/API 使用隔离模拟记录，不修改生产 SQLite。签名地址保存在 0700 目录内的 0600 manifest，浏览器探针关闭 trace；不得提交、打印或共享该 manifest。

```bash
export PARCEL_R2_LIVE_ENDPOINT=https://15cfc46fe23bf82055e97614de76b744.r2.cloudflarestorage.com
export PARCEL_R2_LIVE_BUCKET=parcel
go run ./scripts/r2-browser-probe -action init
PARCEL_BROWSER_R2_MANIFEST="$PWD/.parcel-secrets/browser-probe.json" \
  npm --prefix web run test:e2e -- --grep '真实浏览器'
go run ./scripts/r2-browser-probe -action verify
go run ./scripts/r2-browser-probe -action cleanup
```

使用开发凭据文件 `.parcel-secrets/r2.credentials`；地址为 5 分钟有效期，每次测试前重新生成 manifest。另有显式启用的 `r2-production.spec.ts`，仅当操作员提供受限的短期管理员会话文件时运行真实公网完整前端测试；运行后须撤销并清理生成的分享及管理员会话，禁止使用 trace 记录登录授权。
