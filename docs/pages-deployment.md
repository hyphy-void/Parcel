# 当前部署入口

旧 Pages / Go 网关的部署步骤已退出当前部署文档。线上使用 Workers + D1 + 私有 R2，管理员登录统一为密码 + TOTP，文件在两端浏览器加解密。

请使用 [V3 部署与更新说明](v3-deployment.md)或[中英图文教程](https://parcelwiki.pages.dev/zh)。首次部署、TOTP 绑定、加密分享、备份与恢复均以这两处为准。

仓库保留的 Go/Origin 兼容实现不支持当前 V3 的 TOTP 与文件 E2EE，也不能接管新版密文。历史配置可从 Git 历史查阅，不作为当前上线或回滚流程。
