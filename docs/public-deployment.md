# 当前公网部署

当前线上部署使用 **Workers + D1 + 私有 R2**，管理员通过**密码 + TOTP**登录，文件上传前在浏览器加密、接收后在浏览器解密保存。

域名、运行时变量、R2 CORS、首次绑定与更新步骤统一见 [Cloudflare 部署说明](v3-deployment.md)和[图文教程](https://parcelwiki.pages.dev/zh)。旧 Go/Caddy 直连步骤不再作为当前公网部署入口；独立 Go 代码仅按其原有协议维护，不能读取新版 Cloudflare 部署的密文。
