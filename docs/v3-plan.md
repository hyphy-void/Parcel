# V3：Cloudflare 原生后端

当前生产版本仍是 Pages + Go/SQLite；V3 在 `v3/serverless` 分支开发，正式开源发布另行决定。Workers 承担 API 和 Access 身份验证，D1 是唯一权威状态源，R2 保持私有、16 MiB Multipart 和浏览器直传/直下载。新模式不依赖树莓派、Tunnel 或内部 Origin 服务令牌。原 Go 模式继续保留。

## 完成条件

- [x] 完整兼容管理、上传、密码解锁、分享、下载会话、撤销及历史管理 API。
- [x] D1 原子下载计数、配额预留、幂等创建、授权版本校验，不使用 KV 做精确计数。
- [x] R2 服务端确认分块、大小与不可变任务元数据；完成失败可恢复，取消终止 Multipart。
- [x] 持久化任务租约、后台恢复、Cron 清理和签名 URL/下载会话保留期；删除确认后释放配额。
- [x] 默认拒绝未配置服务、未知路由、伪造 Access 身份和跨域写请求；强密码哈希与全局敏感操作限流。
- [x] 单条部署工具（实现及本地验证）：可重复资源创建、数据库迁移、R2 CORS/生命周期、Secret 配置、打包与验收；提供 CI 部署入口。
- [x] 导出/导入 Go SQLite 的 R2 分享元数据，切换前检查写入冻结、在途上传和保留期；保证只有一套后端写入/清理同一对象。
- [x] Miniflare/workerd 真正的 D1/R2 测试、浏览器闭环、并发与崩溃恢复测试、Go 兼容回归通过。
- [x] 完成部署、备份、切换、回滚和资源预算文档。
- [ ] 配置账户管理 Token 与目标桶 S3 凭据，确认 Workers Paid，真实部署隔离 V3 环境并验收 CPU、Access、签名/CORS、Cron。
- [ ] 验收隔离环境后切换正式域名；正式开源发布仍另行决定。

## 已核实的平台约束

D1 `batch()` 提供事务；不使用 Sessions API 时查询走主库。安全关键查询保持主库语义。[D1 API](https://developers.cloudflare.com/d1/worker-api/d1-database/)

Cloudflare Deploy 按钮支持自动准备 D1/R2，迁移可放入部署脚本；子目录模板必须完全独立，当前仓库使用根目录构建入口。[Deploy 按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)

Workers 目前默认限制单次 PBKDF2 为 100,000 次，提高到一百万的提案尚未合并；不能把本地 workerd 成功当作生产支持高迭代 PBKDF2 的证据。V3 不因此降低既有密码保护，继续使用 Argon2id，并测量执行成本。[平台实现提案](https://github.com/cloudflare/workerd/pull/7550)、[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)

## 本地验收记录（2026-10-10）

- V3 workerd、D1/R2、部署工具、迁移和授权/过期竞态：21 项通过。
- Chromium、Firefox、手机尺寸上传/解锁/下载续签/撤销：3 项通过；两块实际大小为 16 MiB + 3 字节。
- Python 全套迁移/回滚/更新器测试：24 项通过，其中 V3 5 项；Go `go test -race ./...` 与 `go vet ./...` 通过。
- 原 Pages 11 项网关测试、workerd runtime、真实 Go Origin integration 和两个浏览器测试通过。
- 两套前端构建、V3 bundle 和 Wrangler dry-run 已验证；[V3 发布界面](previews/v3-published.png) 来自本地浏览器测试。
- GitHub 两次完整 CI 通过，包含原模式 117 项浏览器回归（3 项条件跳过）以及上述 V3 验收。
- 使用现有桶完成真实 S3 验证：V3 签名器上传 16 MiB + 3 字节，错误 Content-Length 返回 403 SignatureDoesNotMatch，ListParts 正确确认大小与 ETag，完成后的签名下载保留中文文件名、no-store 且 SHA-256 一致。临时 Multipart 和对象已清理，HEAD 为 404。这验证 S3 签名与解析；新桶 CORS、生产 Worker native binding、Access、CPU 与 Cron 仍待部署验证。
- 当前真实部署命令在账户变更前因缺少 `CLOUDFLARE_API_TOKEN` 退出。生产域名、树莓派服务与旧文件未切换。上述本地证据不等同于 Cloudflare 线上验收。
