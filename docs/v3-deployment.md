# V3：Workers + D1 + 私有 R2

V3 的页面和 API 由一个带 Static Assets 的 Worker 托管；D1 是分享、上传任务、下载会话和配额的唯一权威数据库。浏览器用 16 MiB Multipart 直接上传 R2，用短期签名 URL 直接下载。Cloudflare Access 认证管理员，Worker 验证 Access JWT、白名单、Origin 和 CSRF。树莓派、Go、SQLite、Tunnel 和内部 Origin 服务令牌退出这条请求链路。Go 部署模式继续保留，当前生产域名在切换前继续运行旧模式。

```mermaid
flowchart LR
  Browser[浏览器] --> Access[Access 管理员认证]
  Access --> Worker[Workers 页面与 API]
  Browser --> Worker
  Worker --> D1[D1 权威状态与事务]
  Worker --> R2[私有 R2 控制 API]
  Browser <-->|文件直传与直下载| R2
  Cron[Cron 每 5 分钟] --> Worker
```

## 构建和验证

需要 Node 24。首次构建安装两个子项目的锁定依赖，后续可使用 `--skip-install`。

```bash
./scripts/build-v3.sh
npm --prefix cloudflare run test:v3
npm --prefix cloudflare run test:browser:v3
WRANGLER_SEND_METRICS=false node cloudflare/node_modules/wrangler/bin/wrangler.js deploy --dry-run --config wrangler.json
python3 -m unittest discover -s scripts/tests -p test_export_v3.py -v
```

前端构建在 `dist/v3-web/`；测试 Worker bundle 在 `dist/v3/`。不会覆盖 Go 内嵌的 `web/dist/` 或 Pages 产物。V3 测试运行真正的 workerd、D1 与 R2 bindings，S3 ListParts 接口和浏览器跨域传输用测试适配层连接到本地 R2；这些测试不能替代线上 R2 签名、CORS、Access 登录和 CPU 预算验收。

## 一次性账户准备

账户须已启用 R2、建立 Zero Trust 组织及 Workers 子域名。完整密码保护使用与 Go 一样的 Argon2id：32 MiB、2 次迭代、并行度 1。Free Workers 每次请求 CPU 预算为 10 ms，不能据此承诺支持这套密码保护；本地 workerd 验证约 230 ms 是墙钟耗时，生产 CPU 需另外测量。V3 完整模式要求先开通 Workers Paid，工具不会代为开通账单。Worker CPU 上限配置为 30 秒，密码计算同一 isolate 同时只允许一个，敏感公共接口另有 D1 持久限流。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

准备一个仅限目标账户的管理 API Token，权限包括 Workers Scripts Edit、D1 Edit、Workers R2 Storage Write、Access Apps and Policies Write、Access Organizations Read、Access Identity Providers Read/Write；若控制台要求读取权限，补上对应 Read。R2 S3 Token 使用目标桶的 Object Read & Write。管理 Token 与 S3 Token 分开，不能把前者当作后者。

从 [deploy/v3.example.json](../deploy/v3.example.json) 复制配置到忽略目录 `.parcel-v3/deploy.json`，填写账户 ID 和管理员邮箱。`workersPaid` 只能在套餐已启用后设为 `true`。默认创建隔离的 `parcel-v3` Worker、D1 和桶，并保持维护模式。新桶可以通过账户管理 Token 自动创建；S3 凭据须能访问指定桶。已有 D1 须匹配保存的数据库 ID，或明确设置 `allowExistingDatabase:true` 后复用。已有桶必须明确设置 `allowExistingBucket:true`，并保证没有另一套后端正在写入/清理其中的相同对象。

通过本机环境或受保护的 CI Secrets 提供：

- `CLOUDFLARE_API_TOKEN`：账户管理 Token。
- `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY`：目标桶的 S3 凭据。
- `SESSION_SECRET`：可选的 64 位十六进制密钥。本机首次部署自动生成并保存；CI 必须配置长期不变的值。

本机也可把这四项填写到 `.parcel-v3/cloudflare-credentials.json`（0600，忽略提交）；部署工具直接解析 JSON，不执行 shell 内容。环境变量优先于此文件。不要把真实值写在命令行参数、Git 文件或聊天中。部署状态及 Secret 保存到 `.parcel-v3/<name>/`，目录权限 0700，文件权限 0600。该目录必须备份，尤其是 `secrets.json` 中的会话密钥。

## 单条部署命令

```bash
npm run deploy -- --config .parcel-v3/deploy.json --plan
npm run deploy -- --config .parcel-v3/deploy.json
```

`--plan` 只显示计划，完全不访问账户、不创建资源。实际命令先构建，然后复用/创建 D1 和私有 R2，合并专属 CORS 及 Multipart 终止规则，建立独立的管理员 Access 应用，应用数据库迁移，部署维护模式 Worker，通过标准输入上传 Secrets，最后进行公共 API 探测。中断后执行同一条命令可继续；已有无关 R2 规则保留。已有同名 Access 应用必须匹配保存的资源 ID，状态丢失时可把审阅过的 `accessAppId` 写入部署配置。默认不迁移旧域名，不覆盖原 Pages 或 Origin。

管理员 Access 应用覆盖 `/login`、`/admin`、`/admin/*`、`/api/v1/auth/*`、`/api/v1/admin/*`、`/api/v1/uploads`、`/api/v1/uploads/*`，仅允许配置邮箱。分享 `/s/*`、公共分享 API 和静态资源保持可访问。无身份提供商时创建邮件一次性验证码提供商，已有提供商保持原样。[Access API](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/create/)

首次使用独立桶、不迁移旧分享，可以在验证配置后激活：

```bash
npm run deploy -- --config .parcel-v3/deploy.json --activate
```

上线验收需通过管理员 Access 登录，上传 0 字节、小文件和超过 16 MiB 的文件，暂停/续传、密码解锁、下载续签和撤销；确认 Network 中没有 Pi/Origin 请求，文件内容只在浏览器与 R2 之间传输。查看 Workers 实际 CPU、异常及 Cron 执行记录，并确认重试和配额恢复。自动公共探测只证明公开 API 的配置与维护状态，不能证明这整套线上业务验收已完成。

## 迁移现有 Go 的 R2 分享

建议先用隔离桶验收 V3，再单独安排旧分享迁移。使用同一个桶迁移时，两套数据库不能同时写入或清理同一对象。D1 导入保留分享 ID、密码哈希、授权版本、下载次数、下载会话和签名保留期；不复制文件内容。Go 的管理员会话不迁移，管理员在新 Access 应用重新登录。

1. 先在旧 Go 完成或取消所有在途上传，让旧单 PUT 签名过期、暂存对象清理完成。导出会拒绝未完成任务、活跃旧 PUT、未清理暂存对象及本地文件分享。
2. 将 V3 配置指向原 R2 桶，设置 `allowExistingBucket:true`、`active:false`，部署维护模式 Worker。保留原桶 CORS 来源，加入 V3 来源；保留当前旧域名，直到验证完毕。
3. 停止旧 Go 服务和清理进程，保持停止。对原数据库执行导出或用 SQLite backup 取得一致副本。工具同时检查 Go 数据目录 `.lock`，运行中的 Go 会使直接导出失败。保存原 `/etc/parcel/`、SQLite、二进制和部署配置。
4. 导出和导入（生成的配置路径由 Worker 名决定）：

```bash
python3 scripts/export-v3.py /path/to/parcel.db .parcel-v3/go-snapshot.json --bucket EXISTING_BUCKET --writers-frozen
node scripts/import-v3.mjs .parcel-v3/go-snapshot.json .parcel-v3/parcel-v3/wrangler.json --writers-frozen
```

目标 D1 必须空白或属于同一份快照。每批写入可恢复；全部内容、数量和配额验证后才标记导入完成。导入期间 Worker 保持维护。若目标 Worker 曾激活过，应先维护并等待 16 分钟，使旧请求与 Cron 完成，再导入。不要在正在服务的 D1 上导入。旧上传的幂等键仍保留，但重建请求缺少明文密码指纹时会拒绝旧键重用；新上传使用新键。

5. 原 Go 继续停机，激活独立 V3 地址并验收旧分享、密码和已有下载会话。只有 D1 成为唯一写入/清理者后才切换正式域名。域名变更须更新 `PUBLIC_URL`、Access destinations、R2 CORS 和前端访问入口；目前工具刻意只部署隔离 workers.dev 地址，正式域名切换是另一次可审阅的操作。

## 回滚

若 V3 尚未激活、没有任何新状态写入，可以保持 V3 维护，再恢复原 Go 的一致备份与原域名。

V3 激活后，不能直接恢复旧 SQLite：这样会丢掉新增分享、下载次数、撤销和清理结果。先完成/取消 V3 在途上传，将部署配置 `active:false` 后重新部署，等待 16 分钟，使先前请求与最长 15 分钟 Cron 完成。`MAINTENANCE_SINCE` 和远程维护状态会被导出工具核对；若仍有未完成任务或未过期租约，拒绝回滚快照。

```bash
npm run deploy -- --config .parcel-v3/deploy.json
node scripts/export-d1-v3.mjs .parcel-v3/parcel-v3/wrangler.json .parcel-v3/d1-rollback.json
python3 scripts/rollback-v3.py .parcel-v3/d1-rollback.json /path/to/parcel.db --bucket EXISTING_BUCKET --writers-frozen
```

Go 必须停机。回滚工具取得 Go `.lock`，自动保留 SQLite backup，在一个事务中恢复最新的四张权威状态表，保留 Go 管理员配置、现有 R2 对象键与已消费下载次数。确认 Go 的 R2 配置、正式 URL 和旧 Access/Gateway 仍匹配，再恢复域名和 Go 服务。V3 保持维护，避免两套清理器同时工作。

## 清理、备份和容量

Cron 每 5 分钟恢复未完成发布、处理闲置任务、清理过期/撤销/下载次数耗尽的分享。默认分享最长 7 天、下载会话最长 8 小时、签名 URL 5 分钟。对象至少保留到 `signed_until`，远程删除确认后才释放 D1 配额。没有 URL 即时撤销能力，已签发 URL 在短有效期内仍可能可用。[R2 预签名 URL](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

配额默认 20 GiB、单文件默认 8 GiB；只是应用保护额度，不是 Cloudflare 账单硬上限。所有状态事务走 D1 主库，下载计数及容量预留不依赖 KV 或只读副本。`batch()` 的事务和 SQL 触发器使计数、授权和额度一起提交。[D1 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

R2 生命周期规则只终止遗留的未完成 `parcel/v3/` Multipart，不按对象年龄删除已发布文件，避免绕过会话保留期。长时间持续上传仍须在该生命周期截止前完成；默认任务与规则时间窗口约一天。应用 Cron 和生命周期不能保证立刻回收空间，应监测失败任务和实际桶容量。

定期执行 D1 远程导出备份（无需维护，但仅作数据库备份；业务切换仍用冻结快照）：

```bash
node cloudflare/node_modules/wrangler/bin/wrangler.js d1 export DB --remote --config .parcel-v3/parcel-v3/wrangler.json --output .parcel-v3/backup.sql
```

D1 快照不是 R2 文件备份；对象删除与数据库恢复必须一起考虑。保留对象备份或明确可接受的临时文件丢失窗口。审计元数据保留 30 天，过期会话/授权/限流计数由 Cron 清理。部署状态和 Secrets 另行加密备份。

## CI 与正式开源

普通 CI 运行 V3 构建、Wrangler dry-run、workerd/D1/R2、迁移和浏览器测试。`Deploy V3 staging Worker` 工作流只通过手动触发部署，使用 GitHub `v3` Environment 的 `PARCEL_V3_CONFIG` JSON 变量及上述四个 Secrets（会话密钥名为 `PARCEL_V3_SESSION_SECRET`，S3 凭据名为 `PARCEL_V3_R2_ACCESS_KEY_ID`、`PARCEL_V3_R2_SECRET_ACCESS_KEY`）。资源 ID 缓存只含非 Secret 状态；设置 Environment 分支限制和审批以控制真正部署。

当前 V3 分支用于实现和验收，不改变仓库可见性，不发布 Release，不创建正式开源 Deploy 按钮。准备正式开源时再决定许可证、公开仓库、模板与发布版本。Cloudflare Deploy 按钮可自动准备 D1/R2，但 Access 和账单前置条件须在可公开模板中明确说明。[Deploy 按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
