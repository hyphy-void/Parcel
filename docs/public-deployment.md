# 公网 HTTPS 直连部署

入口为 `浏览器 → Caddy HTTPS → 127.0.0.1:8080 Parcel HTTP`。使用单一域名；公网 IPv4、IPv6 或双栈由网络和 Caddy 提供。HTTPS 保护传输，服务器文件仍为明文，已保存到接收者设备的文件无法收回。

## DNS 和网络

A 指向可入站公网 IPv4（需要时在路由器配置端口映射），AAAA 指向服务器的实际公网 IPv6，不使用路由器自身地址或临时隐私地址。Cloudflare DNS 使用**仅 DNS/灰云**。没有可入站公网 IPv4 时只配 AAAA，接收者需要可用 IPv6。

公网地址变化由路由器或独立 DDNS 工具更新，Parcel 不持有 DNS API 凭据。主机及路由器都需允许 TCP 80、443 入站，保留现有 SSH/VPN 规则，不向公网开放 8080 或 Caddy 2019 管理端口。UDP 443 可按需支持 HTTP/3，TCP HTTPS 不依赖它。

局域网能连接公网 IPv6 不等于跨网可达。Caddy 的 ACME 验证需要证书颁发机构从公网访问服务器；DNS 正确仍可能被路由器或运营商阻挡。应先取得受信任证书，再切换正式 Parcel 的 BASE_URL。

## Caddy 与应用

使用 [Caddyfile.example](../deploy/Caddyfile.example) 替换域名和允许的管理来源，安装到 `/etc/caddy/Caddyfile`。样例只向公网开放分享页面、静态资源、分享 API 和下载 API。登录、上传、管理 API、健康检查和未来新增路由默认仅限管理来源。

管理来源由 `remote_ip` 判断实际 TCP 对端，不信任客户端代理头。`100.64.0.0/10` 用于 Tailscale，可按设备收窄。局域网 IPv6 如需管理，应添加实际可信 LAN 前缀，而非所有公网 IPv6；前缀变化时同步维护规则。不要把来源网段添加到应用的可信代理列表。

入口相关应用配置如下，保留实际存储、挂载和配额设置：

```ini
PARCEL_LISTEN_ADDR=127.0.0.1:8080
PARCEL_BASE_URL=https://parcel.example.com
PARCEL_TRUSTED_PROXIES=127.0.0.1/32
```

代理 CIDR 逗号分隔。默认不信任任何代理头；受信任连接的 X-Forwarded-For 从右向左解析，到首个不可信节点即停止。无效头回退到连接地址，避免伪造 IP 绕过限流。Host 和 Origin 始终校验固定 BASE_URL，不信任 X-Forwarded-Host/Proto。

```bash
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
sudo systemctl restart parcel
curl -fsS -H 'Host: parcel.example.com' http://127.0.0.1:8080/readyz
```

管理员通过 LAN 或 VPN 路径访问同一 HTTPS 域名；必要时在管理设备上用本地 DNS 覆盖，将域名指向服务器的 LAN/Tailscale 地址，保持域名及证书匹配。公网 AAAA 连接呈现的来源可能也是公网 IPv6，需要与允许网段匹配。切换 BASE_URL 后应重新登录；旧地址生成的分享链接不自动迁移。

Caddy 自动管理证书续期。样例不启用访问日志，因为下载 URL 是授权凭证。不要启用文件或 API 缓存，它会绕过权限及撤销检查；应用已返回 `private, no-store`。

## 验收

已安装 Caddy 和 Python 3 时，运行独立路由验收：

```bash
python3 scripts/caddy-acceptance.py --binary /opt/parcel/parcel --config deploy/Caddyfile.example
```

脚本在临时目录运行独立 Parcel/Caddy，仅使用回环端口 18080、18780，不修改正式数据。通过不同实际来源检查管理拒绝及伪造代理头，再验证上传、公开分享、Range 续传、下载次数及撤销。这个测试使用 HTTP；TLS 行为由 Go 的 IPv4/IPv6 HTTPS 反代测试覆盖。

正式部署另需跨网验证：HTTP 跳转到 HTTPS；证书可信且域名正确；公开分享可下载和续传；公网访问登录、上传及管理 API 返回 403，即使伪造代理头或带管理 Cookie 也一样。管理网络仍需通过登录和 CSRF 验证。仅有本地测试不能宣称公网验收通过。
