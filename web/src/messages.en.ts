// Chinese source text is the shared key for both UI builds.
export const english: Record<string, string> = {
  "请求过于频繁，请稍后重试": "Too many requests. Please try again later",
  上传不存在: "Upload not found",
  分享不存在: "Share not found",
  "旧版分享已停用，请重新加密上传文件":
    "This older share is disabled. Encrypt and upload the file again",
  密码保护与加密密钥封装不一致:
    "Password protection does not match the encrypted key envelope",
  密码验证和文件加密必须使用独立的派生参数:
    "Password verification and file encryption must use separate derivation parameters",
  任务不存在: "Task not found",
  上传状态已改变: "Upload status has changed",
  "任务正在处理，请稍后重试":
    "The task is being processed. Please try again later",
  "任务处理超时，请重试": "Task processing timed out. Please try again",
  文件超过大小限制: "The file exceeds the size limit",
  文件名和校验值必须在浏览器端加密:
    "The filename and checksum must be encrypted in the browser",
  上传请求包含不支持的加密参数:
    "The upload request contains unsupported encryption parameters",
  请使用端到端加密上传协议: "Use the end-to-end encrypted upload protocol",
  "超过 100 MB 需要确认后上传": "Confirm before uploading files over 100 MB",
  分享有效期不合法: "Invalid share lifetime",
  "下载次数应为 1–100，或选择不限次数":
    "Set the download limit to 1–100 or choose unlimited",
  请使用浏览器密码处理协议: "Use the browser password processing protocol",
  幂等键不合法: "Invalid request identifier",
  幂等键已用于其他上传:
    "The request identifier was already used for another upload",
  "R2 存储保护额度不足或未完成任务过多，请等待清理释放空间":
    "Insufficient R2 storage quota or too many unfinished tasks. Wait for cleanup to free space",
  分块编号不合法: "Invalid part number",
  "R2 分块尚未完整或大小不匹配":
    "R2 parts are incomplete or their sizes do not match",
  "R2 分块大小与任务不一致": "The R2 part size does not match the upload task",
  "R2 对象与上传任务不一致": "The R2 object does not match the upload task",
  "发布租约失效，将自动恢复":
    "The publishing lease expired. Recovery is automatic",
  "存储服务暂时不可用，将自动重试":
    "Storage is temporarily unavailable. Retrying automatically",
  "上传已进入发布流程，请查询结果或撤销分享":
    "Publishing has started. Check the result or revoke the share",
  分享密码不正确: "Incorrect share password",
  "分享权限已经改变，请重新打开链接":
    "Share permissions changed. Open the link again",
  密码保护参数不正确: "Invalid password protection parameters",
  密码更新请求包含不支持的加密参数:
    "The password update contains unsupported encryption parameters",
  请提供新密码或明确移除密码保护:
    "Provide a new password or explicitly remove password protection",
  请提供重新封装后的加密密钥: "Provide the rewrapped encryption key",
  文件加密参数不能改变: "File encryption parameters cannot be changed",
  "分享设置已经改变，请刷新后重试":
    "Share settings changed. Refresh and try again",
  下载请求标识已用于其他分享:
    "The download request identifier was already used for another share",
  "原下载会话已失效，请明确建立新会话":
    "The original download session expired. Start a new session to continue",
  下载请求标识不合法: "Invalid download request identifier",
  请先验证分享密码: "Verify the share password first",
  下载会话无效: "Invalid download session",
  下载会话或分享已失效: "The download session or share has expired",
  分享已失效或下载次数已用完:
    "The share has expired or reached its download limit",
  分享权限或下载资格已经改变:
    "Share permissions or download eligibility changed",
  请提供有效幂等键: "Provide a valid request identifier",
  "文件清理失败，将自动重试": "File cleanup failed. Retrying automatically",
  "上传清理失败，将自动重试": "Upload cleanup failed. Retrying automatically",
  "发布等待超时，任务将清理":
    "Publishing timed out. The task will be cleaned up",
  "无法打开本机续传存储。请允许网站存储后重试。":
    "Unable to open local resume storage. Allow site storage and try again.",
  "本机存储升级被另一标签页阻止，请关闭其他 Parcel 页面后重试。":
    "Another tab is blocking the local storage upgrade. Close other Parcel tabs and try again.",
  本机续传记录保存失败: "Unable to save the local resume record",
  "无法保存本机下载会话标识。": "Unable to save the local download session ID.",
  "本机续传空间不足。已接收的密文会保留；请释放磁盘空间后继续。":
    "Local resume storage is full. Received encrypted data is retained. Free disk space to continue.",
  "密文续传记录保存失败，请检查本机存储权限。":
    "Unable to save the encrypted resume record. Check local storage permissions.",
  "本机可用续传空间不足。下载需临时保存一份密文，请释放磁盘空间或换用空间充足的设备。":
    "Insufficient local resume space. Downloading requires a temporary encrypted copy. Free disk space or use a device with more space.",
  "密码处理失败，请重试": "Password processing failed. Please try again",
  "本地加密准备失败，请重试":
    "Local encryption preparation failed. Please try again",
  "加密信息不正确，请重新打开完整分享链接":
    "Invalid encryption information. Open the complete share link again",
  文件大小超出端到端加密支持范围:
    "File size exceeds the supported encryption range",
  文件分块位置不正确: "Invalid file part offset",
  已取消: "Cancelled",
  本地加密准备失败: "Local encryption preparation failed",
  "无法加载加密模块，请刷新后重试":
    "Unable to load the encryption module. Refresh and try again",
  请输入分享密码: "Enter the share password",
  "分享密码或解密密钥不正确，或加密信息已损坏":
    "Incorrect share password or decryption key, or damaged encryption information",
  "所选文件与原上传文件内容不同，请选择原文件继续上传":
    "The selected file’s contents differ from the original. Select the original file to resume",
  所选文件大小不正确: "The selected file has an incorrect size",
  "此文件加密重试次数过多，请创建新的上传任务":
    "Too many encryption retries for this file. Create a new upload",
  "加密文件分块长度不正确，下载内容可能不完整":
    "Incorrect encrypted part length. The download may be incomplete",
  "文件分块认证失败，内容可能被修改或来自其他文件":
    "File part authentication failed. The contents may have changed or belong to another file",
  "密钥备份密码需要 12 至 256 字节":
    "Key backup passphrases must be between 12 and 256 bytes",
  密钥备份文件过大: "The key backup file is too large",
  无法识别密钥备份文件: "Unrecognized key backup file",
  "备份密码不正确，或密钥备份已损坏":
    "Incorrect backup passphrase or damaged key backup",
  密码不正确: "Incorrect password",
  "密码或验证码不正确，已使用的动态码需等待下一次更新":
    "Incorrect password or authenticator code. If the code was already used, wait for the next code.",
  请求未经过受信任入口:
    "The request did not pass through a trusted entry point",
  "尝试次数过多，请一分钟后重试": "Too many attempts. Try again in one minute",
  "管理员已初始化，请直接登录": "Admin setup is complete. Please log in",
  请使用安全密码处理模块: "Use the secure password processing module",
  "密码参数不正确，请刷新重试":
    "Invalid password parameters. Refresh and try again",
  "绑定已过期，请重新开始": "Enrollment expired. Please start again",
  "管理员凭据已更新，请重新登录":
    "Admin credentials changed. Please log in again",
  请通过管理入口验证身份: "Sign in through the admin login",
  "请求验证失败，请刷新页面": "Request verification failed. Refresh the page",
  请先登录: "Please log in first",
  "登录已失效，请重新登录": "Your login has expired. Please log in again",
  "管理员使用 Cloudflare Access 登录":
    "Administrators sign in with Cloudflare Access",
  请先在服务器初始化管理员密码:
    "Initialize the admin password on the server first",
  "密码验证繁忙，请稍后重试":
    "Password verification is busy. Please try again later",
  "密码长度最多为 256 字节": "Passwords can be at most 256 bytes",
  "密码保护参数不正确，请重新打开分享":
    "Invalid password protection parameters. Open the share again",
  "密码处理超时，请重试": "Password processing timed out. Please try again",
  密码处理失败: "Password processing failed",
  "无法加载密码处理模块，请刷新重试":
    "Unable to load the password processing module. Refresh and try again",
  不支持的未加密分享: "Unsupported unencrypted share",
  "加密文件（本机无密钥）": "Encrypted file (key unavailable in this browser)",
  "正在加载…": "Loading…",
  跳到主要内容: "Skip to main content",
  临时文件分享: "Temporary file sharing",
  管理入口: "Admin login",
  我的分享: "My shares",
  上传文件: "Upload file",
  登录安全: "Login security",
  退出: "Log out",
  退出登录: "Log out",
  主导航: "Main navigation",
  "GitHub 仓库（在新标签页打开）": "GitHub repository (opens in a new tab)",
  "GitHub 仓库": "GitHub repository",
  "让文件轻装上路。": "Send files with ease.",
  "自托管存储，到期自动清理": "Self-hosted storage, automatic expiry cleanup",
  部署手册: "Deployment guide",
  "我用 Parcel 分享了「{0}」\n链接：{1}{2}":
    "I shared “{0}” with Parcel\nLink: {1}{2}",
  "\n提取码：请向分享者获取": "\nPasscode: ask the sender",
  "\n提取码：{0}": "\nPasscode: {0}",
  "分享文案已选中，请使用系统的复制操作。":
    "Share message selected. Use your device’s copy command.",
  "分享文案已复制，可以粘贴发送给对方。":
    "Share message copied. Paste it to send.",
  "暂时无法打开系统分享，请复制文案后发送。":
    "System sharing is unavailable. Copy the message to send it.",
  分享链接: "Share link",
  复制分享链接: "Copy share link",
  "分享链接已复制。": "Share link copied.",
  "链接已选中，请使用系统的复制操作。":
    "Link selected. Use your device’s copy command.",
  分享: "Share",
  分享文件: "Share file",
  关闭分享: "Close sharing dialog",
  "复制下面的文案，发给接收文件的人。":
    "Copy the message below and send it to the recipient.",
  "无法读取原提取码，请另外发送，或在分享详情中设置新密码。":
    "The original passcode is unavailable. Send it separately or set a new password in share details.",
  分享文案: "Share message",
  复制分享文案: "Copy share message",
  已复制: "Copied",
  系统分享: "Share with an app",
  "正在打开…": "Opening…",
  文件: "File",
  "分享一份文件，": "Share a file.",
  "少一份牵挂。": "Leave the rest to us.",
  "上传，发出链接。": "Upload. Send the link.",
  "到期自动清理。": "Expiry takes care of cleanup.",
  "文件分享，从这里开始。": "File sharing starts here.",
  "验证管理员身份后，上传文件并管理分享。":
    "Sign in as an administrator to upload files and manage shares.",
  进入管理页面: "Open admin page",
  "登录后上传文件，创建你的临时分享。":
    "Sign in to upload a file and create a temporary share.",
  管理员密码: "Admin password",
  "登录 Parcel": "Log in to Parcel",
  "正在登录…": "Logging in…",
  "密码由服务器管理员初始化。": "The server administrator sets the password.",
  "已清除 {0} 条已清理记录。": "Removed {0} cleaned-up records.",
  "把文件交给对方，把收尾交给 Parcel。":
    "Send the file. Let Parcel handle the cleanup.",
  新建分享: "New share",
  存储用量: "Storage usage",
  "R2 存储额度": "R2 storage quota",
  "上传预留 {0} · 待清理 {1}":
    "Reserved for uploads: {0} · Pending cleanup: {1}",
  "上传及临时预留 {0} · 剩余 {1} GB":
    "Uploads and temporary reservations: {0} · Available: {1} GB",
  "额度保护已启用 · 满额暂停新上传":
    "Quota protection enabled · New uploads pause when full",
  "额度已满，暂停新上传": "Quota full. New uploads paused",
  分享记录: "Share history",
  个分享: " shares",
  "到期、撤销或次数用完后自动回收文件":
    "Files are reclaimed after expiry, revocation, or the download limit",
  你的服务器: "Your server",
  云端服务: "Cloud service",
  本地存储: "Local storage",
  "私有 R2 存储": "Private R2 storage",
  "本地磁盘可用 {0}": "Local disk available: {0}",
  "Cloudflare 原生后端": "Cloudflare backend",
  "按 Parcel 管理的文件计量，包含尚未释放的临时空间。账户月度免费存储与读写额度以 Cloudflare 为准。":
    "Usage covers files managed by Parcel, including temporary space awaiting release. Cloudflare determines the account’s monthly free storage and operation quotas.",
  个文件: " files",
  刷新: "Refresh",
  清除已清理: "Clear cleaned-up records",
  清除: "Clear",
  "条已清理记录？": " cleaned-up records?",
  "记录清除后无法恢复。可下载和等待清理的分享会保留。":
    "Removed records cannot be restored. Available shares and shares awaiting cleanup will be kept.",
  取消: "Cancel",
  确认清除: "Confirm removal",
  "正在清除…": "Removing…",
  "这里，留给你要分享的文件。": "A place for the files you want to share.",
  "上传文件，设置规则，把链接交给需要的人。":
    "Upload a file, set the rules, and send the link.",
  已用下载资格: "Download slots used",
  状态: "Status",
  无密码: "No password",
  密码保护: "Password protection",
  不限次数: "Unlimited",
  下载资格: "Download slots",
  上一页: "Previous page",
  第: "Page ",
  页: " ",
  下一页: "Next page",
  "单文件不能超过 {0}": "A single file cannot exceed {0}",
  "请选择原来的文件；文件名、大小或修改时间与上传记录不一致。":
    "Select the original file. Its name, size, or modification time does not match the upload record.",
  "发布确认超时，上传任务已保留。可稍后查询结果，无需重新上传文件。":
    "Publishing confirmation timed out. The upload is saved. Check the result later without uploading the file again.",
  "暂时无法查询发布结果，上传任务已保留。请稍后再查询。":
    "Unable to check the publishing result. The upload is saved. Please check again later.",
  "上传已经失效，请重新上传": "This upload has expired. Please upload again",
  "{0}。上传任务已保留，可稍后查询结果。":
    "{0}. The upload is saved. Check the result later.",
  上传已暂停: "Upload paused",
  上传失败: "Upload failed",
  服务器响应异常: "Unexpected server response",
  存储服务拒绝了请求: "The storage service rejected the request",
  存储访问被拒绝: "Storage access denied",
  上传签名校验失败: "Upload signature verification failed",
  "R2 {0}上传失败（HTTP {1}）：{2}。上传任务已保留。":
    "R2 {0} upload failed (HTTP {1}): {2}. The upload is saved.",
  分块: "part",
  整文件: "whole-file",
  "连接中断或 R2 CORS 未配置":
    "Connection interrupted or R2 CORS is not configured",
  分块传输超时: "Part transfer timed out",
  整文件传输超时: "Whole-file transfer timed out",
  "请输入 1 到 100 之间的整数。": "Enter a whole number between 1 and 100.",
  "分享密码至少需要 4 字节，例如 abcd。":
    "The share password must be at least 4 bytes, for example abcd.",
  "文件超过 100 MB（100,000,000 字节），大小为 {0}。确认继续上传？":
    "This file exceeds 100 MB (100,000,000 bytes). Its size is {0}. Continue uploading?",
  "R2 已响应上传成功，但服务端尚未确认完整对象。任务已保留，请稍后继续；不会自动重传整个文件。":
    "R2 reported a successful upload, but the server has not confirmed the complete object. The task is saved. Continue later; the whole file will not be uploaded again automatically.",
  "取消这次上传？已上传的数据和续传记录将被删除，无法恢复。":
    "Cancel this upload? Uploaded data and resume records will be deleted and cannot be restored.",
  "文件已装好，交给对方吧。": "Your file is ready to share.",
  分享密码: "Share password",
  到期自动失效: "Expires automatically",
  "{0} 次": "{0} downloads",
  新下载资格: "New download slots",
  查看分享详情: "View share details",
  返回我的分享: "Back to my shares",
  "选一份文件，设好规则，就可以发送链接了。":
    "Choose a file, set the rules, and send the link.",
  选择文件: "Choose file",
  单文件分享: "One file per share",
  把文件放在这里: "Drop your file here",
  "重新选择 {0}": "Select {0} again",
  "正在读取服务器配置…": "Loading server settings…",
  "支持单个文件，最大 {0}": "One file, up to {0}",
  "点击选择，或拖入文件": "Click to choose or drag a file here",
  重新选择文件: "Choose another file",
  选择要分享的文件: "Choose a file to share",
  "发现未完成上传。重新选择原文件后可继续；文件名与大小匹配不能保证内容未改变。":
    "An unfinished upload was found. Select the original file to continue. Matching the name and size does not guarantee unchanged content.",
  "这是启用 R2 前创建的本地上传任务，继续上传仍会经过服务器。 如需直传 R2，请取消这次上传后新建任务。":
    "This local upload was created before R2 was enabled and will continue through the server. To upload directly to R2, cancel this upload and create a new one.",
  "正在上传…": "Uploading…",
  "传输完成，正在确认…": "Transfer complete. Confirming…",
  "等待重试…": "Waiting to retry…",
  上传未完成: "Upload incomplete",
  等待发布结果: "Waiting for publishing result",
  "传输完成，正在发布…": "Transfer complete. Publishing…",
  文件上传进度: "File upload progress",
  已上传: "Uploaded",
  "正在核对文件并生成分享链接，无需重新上传。":
    "Checking the file and creating the share link. No need to upload again.",
  "文件只保存在本机。分享失效后，Parcel 会自动回收空间。":
    "The file is stored on this server. Parcel reclaims the space when the share expires.",
  "文件直传到私有 R2 存储。分享失效后，Parcel 会自动回收空间。":
    "The file uploads directly to private R2 storage. Parcel reclaims the space when the share expires.",
  分享规则: "Share settings",
  有效期: "Expires after",
  "{0} 秒": "{0} seconds",
  "7 天": "7 days",
  "24 小时": "24 hours",
  "1 小时": "1 hour",
  "从文件校验并发布成功时开始计算。":
    "Starts when the file is verified and successfully published.",
  下载次数: "Download limit",
  "不限次数…": "Unlimited…",
  不限下载次数: "Unlimited downloads",
  "首次准许传输消耗一次，同一会话续传不重复计数。":
    "The first approved transfer uses one slot. Resuming the same session uses no additional slots.",
  "获取下载地址消耗一次，同一会话续签不重复计数。":
    "Getting a download URL uses one slot. Renewing the same session uses no additional slots.",
  "有效期内可不限次数下载，密码保护仍然生效。":
    "Downloads are unlimited until expiry. Password protection still applies.",
  "例如 abcd…": "For example, abcd…",
  换一个: "Generate another",
  上传并创建分享: "Upload and create share",
  继续上传: "Resume upload",
  查询发布结果: "Check publishing result",
  "正在校验…": "Verifying…",
  "正在完成上传…": "Finishing upload…",
  暂停上传: "Pause upload",
  取消这次上传: "Cancel this upload",
  "密码保护已关闭，旧授权已失效。":
    "Password protection disabled. Previous authorizations are invalid.",
  "密码已更新，旧授权已失效。分享文案会附上新提取码。":
    "Password updated. Previous authorizations are invalid. The share message includes the new passcode.",
  无法读取分享: "Unable to load share",
  "请检查链接，或返回我的分享重新选择。":
    "Check the link or return to your shares and choose again.",
  分享详情: "Share details",
  "· 创建于": "· Created ",
  到期时间: "Expires at",
  未启用: "Disabled",
  已启用: "Enabled",
  "对象大小及上传任务已由服务端核验；ETag 不是 SHA-256。":
    "The server verified the object size and upload task. ETag is not SHA-256.",
  "次数用完后，已开始的有效会话仍可续传；会话结束后再回收文件。":
    "Active sessions can resume after the download limit is reached. The file is reclaimed when those sessions end.",
  打开接收页: "Open download page",
  管理分享: "Manage share",
  "此分享已失效。需要重新分享时，请创建新的分享。":
    "This share is no longer available. Create a new share to send the file again.",
  修改分享密码: "Change share password",
  "例如 abcd；留空关闭密码保护…":
    "For example, abcd; leave blank to disable protection…",
  保存密码设置: "Save password settings",
  "正在保存…": "Saving…",
  撤销分享: "Revoke share",
  "撤销后，链接立即失效，文件将进入清理流程。":
    "Revoking immediately disables the link and queues the file for cleanup.",
  确认撤销: "Confirm revocation",
  保留分享: "Keep share",
  "下载会话或分享已失效，请重新打开链接。":
    "The download session or share has expired. Open the link again.",
  "下载繁忙，请稍后重试。": "Downloads are busy. Please try again later.",
  接收文件: "Receive file",
  有效期至: "Available until",
  剩余新下载资格: "Remaining new download slots",
  下载文件: "Download file",
  "再次下载 / 继续": "Download again / resume",
  "正在准备…": "Preparing…",
  "若下载未开始，点击此处重新下载":
    "If the download did not start, click here to retry",
  "首次准许传输消耗一次资格。": "The first approved transfer uses one slot.",
  "获取下载地址消耗一次资格。": "Getting a download URL uses one slot.",
  "同一有效会话内重试不重复扣次。文件保存进度请查看浏览器下载列表。":
    "Retries within the same valid session use no additional slots. Check your browser’s download list for save progress.",
  "下载地址有效 5 分钟。断线后点击下载会续签同一会话，不重复扣次数；下载工具续传时请替换地址并保留 Range 偏移。":
    "Download URLs last 5 minutes. Clicking download after a disconnect renews the same session without using another slot. In a download tool, replace the URL and keep the Range offset to resume.",
  "下载次数已用完，请联系分享者。":
    "The download limit has been reached. Contact the sender.",
  "输入密码，打开这份分享。": "Enter the password to open this share.",
  "这份文件设置了密码保护。": "This file is password protected.",
  解锁文件: "Unlock file",
  "正在验证…": "Verifying…",
  分享已失效: "Share unavailable",
  "文件无法继续下载，请联系分享者重新发送。":
    "This file can no longer be downloaded. Ask the sender to share it again.",
  无法打开分享: "Unable to open share",
  "请检查链接，或联系分享者重新发送。":
    "Check the link or ask the sender to send it again.",
  "由分享者的 Parcel 服务器交付": "Delivered by the sender’s Parcel server",
  暂时无法连接: "Unable to connect",
  "请刷新页面重试，或稍后再次打开。":
    "Refresh to retry or open this page again later.",
  页面不存在: "Page not found",
  "返回 Parcel": "Back to Parcel",
  "本机上传密钥缺失，无法生成可解密链接。请勿清理此浏览器的网站数据。":
    "The upload key is missing from this browser. A decryptable link cannot be created. Keep this browser’s site data.",
  "续传密钥已丢失，无法安全恢复本次上传。请取消任务后重新创建分享。":
    "The resume key is missing. This upload cannot be safely resumed. Cancel it and create a new share.",
  "服务器不支持独立的客户端密码验证协议，已停止创建分享。":
    "The server does not support the independent client password verification protocol. Share creation has stopped.",
  "链接的 # 后含解密密钥，请完整发送。密钥仅保存在本机浏览器；丢失后服务器无法找回。":
    "The decryption key follows # in the link. Send the entire link. The key is stored only in this browser; the server cannot recover it.",
  "发现未完成加密上传。重新选择原文件后会校验完整 SHA-256，再续传未完成的块。请保留此浏览器的网站数据。":
    "An unfinished encrypted upload was found. Select the original file to verify its full SHA-256 and resume incomplete parts. Keep this browser’s site data.",
  "正在本机校验原文件并准备加密…":
    "Verifying the original file locally and preparing encryption…",
  "当前服务必须支持端到端加密协议后才能创建分享。":
    "This service must support end-to-end encryption before you can create a share.",
  "浏览器分块加密后直传私有 R2，服务器不接收文件密钥和原始文件名。分享失效后自动回收密文。":
    "The browser encrypts parts and uploads directly to private R2. The server receives neither the file key nor the original filename. Encrypted data is reclaimed when the share expires.",
  "建议保留随机长密码，并通过与分享链接不同的渠道发送。拿到完整链接和密文的人可离线尝试密码。":
    "Keep the randomly generated long password and send it through a different channel from the link. Anyone with the complete link and encrypted data can try passwords offline.",
  "此浏览器没有这份分享的密钥，请先导入密钥备份。":
    "This browser does not have the share key. Import a key backup first.",
  "加密密钥备份已导出。请离线保存，并单独保管备份口令。":
    "Encrypted key backup exported. Save it offline and keep the backup passphrase separately.",
  "密钥备份文件过大。": "The key backup file is too large.",
  "该备份不属于这份分享。": "This backup does not belong to this share.",
  "密钥已导入此浏览器。现在可以复制完整链接和管理密码。":
    "Key imported into this browser. You can now copy the complete link and manage the password.",
  "备份 / 导入本机分享密钥": "Back up / import local share key",
  "文件密钥仅保存在创建分享的浏览器。换设备或清除网站数据前，请导出加密备份。服务器和管理员登录都不能找回丢失的密钥。":
    "File keys are stored only in the browser that created the share. Export an encrypted backup before changing devices or clearing site data. The server and admin login cannot recover lost keys.",
  "备份口令（至少 12 字节）": "Backup passphrase (at least 12 bytes)",
  导出加密备份: "Export encrypted backup",
  "正在处理…": "Processing…",
  导入备份文件: "Import backup file",
  导入密钥备份: "Import key backup",
  "此浏览器没有文件密钥。请导入加密备份后再修改密码。":
    "This browser does not have the file key. Import an encrypted backup before changing the password.",
  "服务器未提供安全的密码验证协议。":
    "The server did not provide a secure password verification protocol.",
  "密码保护已关闭，旧下载授权已失效。完整链接仍包含解密密钥。":
    "Password protection disabled. Previous download authorizations are invalid. The complete link still includes the decryption key.",
  "密码已更新，无需重传文件。旧下载授权已失效；已持有旧密钥与密文的人仍可读取已有副本。":
    "Password updated without uploading again. Previous download authorizations are invalid. Anyone who already has the old key and encrypted data can still read their copies.",
  "此浏览器没有解密密钥，无法显示文件名或复制可用链接。可以撤销分享，或从原设备导出密钥备份后在下方导入。":
    "This browser does not have the decryption key, so the filename and a working link are unavailable. You can revoke the share or export a key backup from the original device and import it below.",
  "服务端仅核验密文大小及上传任务；浏览器解密时会校验每块认证标签和原文件 SHA-256。ETag 不是 SHA-256。":
    "The server verifies only the encrypted size and upload task. During decryption, the browser verifies every part’s authentication tag and the original file’s SHA-256. ETag is not SHA-256.",
  "二维码生成失败，可使用下方密钥手动绑定。":
    "QR code generation failed. Use the key below to set up your authenticator manually.",
  "绑定已过期，请重新开始。": "Enrollment expired. Please start again.",
  "请设置至少 12 位密码，并确认两次输入一致。":
    "Set a password of at least 12 characters and make sure both entries match.",
  "Parcel 管理员恢复码\n{0}\n\n每个恢复码仅可使用一次，需要同时输入管理员密码。\n重新绑定认证器后，旧恢复码全部失效。请离线妥善保存。\n\n{1}\n":
    "Parcel admin recovery codes\n{0}\n\nEach recovery code can be used once and requires the admin password.\nEnrolling a new authenticator invalidates all old recovery codes. Store these codes securely offline.\n\n{1}\n",
  登录成功: "Login successful",
  "正在进入管理页面。若页面未跳转，可使用下方链接。":
    "Opening the admin page. If you are not redirected, use the link below.",
  管理员登录: "Admin login",
  "正在加载登录设置…": "Loading login settings…",
  重新加载: "Reload",
  保存恢复码: "Save recovery codes",
  "认证器已绑定。丢失手机时，使用管理员密码和恢复码重新绑定。":
    "Authenticator enrolled. If you lose your phone, use the admin password and a recovery code to enroll a new authenticator.",
  "恢复码仅显示这一次。每个只能使用一次，请保存在安全的位置。":
    "These recovery codes are shown only once. Each can be used once. Store them securely.",
  一次性恢复码: "One-time recovery codes",
  下载恢复码: "Download recovery codes",
  我已安全保存恢复码: "I have stored the recovery codes securely",
  更换认证器: "Replace authenticator",
  恢复认证器: "Recover authenticator",
  设置管理员登录: "Set up admin login",
  扫码绑定认证器: "Scan to enroll authenticator",
  "输入管理员密码和认证器中的动态验证码。":
    "Enter the admin password and the current code from your authenticator.",
  "验证密码和当前动态码后，绑定新的认证器。完成后其他登录和旧恢复码都会失效。":
    "Verify your password and current code to enroll a new authenticator. This invalidates other logins and old recovery codes.",
  "输入管理员密码和一个未使用的恢复码，重新绑定认证器。":
    "Enter the admin password and an unused recovery code to enroll a new authenticator.",
  "输入初始化密钥并设置密码，然后绑定认证器。":
    "Enter the setup token, set a password, and enroll your authenticator.",
  "用认证器扫描二维码，再输入生成的 6 位动态验证码。":
    "Scan the QR code with your authenticator and enter its 6-digit code.",
  初始化密钥: "Setup token",
  确认密码: "Confirm password",
  "正在生成二维码…": "Generating QR code…",
  "使用认证器扫描此二维码绑定 Parcel":
    "Scan this QR code with your authenticator to enroll Parcel",
  "无法扫码？手动输入密钥": "Cannot scan? Enter the key manually",
  "账户：Parcel 管理员；类型：基于时间；6 位数字，每 30 秒更新。":
    "Account: Parcel Admin. Type: time-based. 6 digits, updated every 30 seconds.",
  "请在 10 分钟内完成。二维码和密钥可生成登录验证码，请勿分享。":
    "Complete within 10 minutes. The QR code and key generate login codes. Keep them private.",
  动态验证码: "Authenticator code",
  恢复码: "Recovery code",
  "使用认证器当前显示的 6 位数字。若刚刚用过，请等待下一次更新。":
    "Use the current 6-digit code from your authenticator. If you just used it, wait for the next code.",
  "确认新认证器后，该恢复码和其余旧恢复码都会失效。":
    "Confirming the new authenticator invalidates this recovery code and all other old codes.",
  继续绑定认证器: "Continue to authenticator setup",
  确认绑定: "Confirm enrollment",
  "请先在部署设置中配置管理员初始化密钥，再刷新此页。":
    "Configure the admin setup token in your deployment settings, then refresh this page.",
  "无法使用认证器？使用恢复码":
    "Cannot use your authenticator? Use a recovery code",
  返回动态验证码登录: "Back to authenticator login",
  重新开始绑定: "Restart enrollment",
  "密码与认证器双重验证。": "Password and authenticator verification.",
  "这份分享使用旧协议，无法在端到端加密模式下打开。请联系分享者重新上传。":
    "This share uses an older protocol and cannot be opened with end-to-end encryption. Ask the sender to upload it again.",
  "密码或链接密钥不正确，无法解密这份分享。":
    "The password or link key is incorrect. This share cannot be decrypted.",
  "服务器未提供端到端加密续传会话。":
    "The server did not provide an encrypted download resume session.",
  "清除本机密文续传缓存？已保存的文件和服务器上的分享不会改变。再次下载需要重新传输密文。":
    "Clear the local encrypted resume cache? Saved files and the share on the server will remain. Downloading again will transfer the encrypted data again.",
  "原下载会话已失效。建立新会话会再消耗一次下载资格；本机已有密文块会继续使用。是否继续？":
    "The original download session has expired. A new session uses another download slot. Cached encrypted parts will be reused. Continue?",
  "正在本机读取加密信息…": "Reading encryption information locally…",
  接收加密文件: "Receive encrypted file",
  密文接收进度: "Encrypted download progress",
  解密保存进度: "Decryption and save progress",
  "已接收并校验 {0} 密文，可从完整块继续。":
    "Received and verified {0} of encrypted data. Resume from complete parts.",
  "密文已完整接收，准备保存原文件。":
    "Encrypted download complete. Ready to save the original file.",
  "正在解密并保存 {0}": "Decrypting and saving {0}",
  继续接收密文: "Resume encrypted download",
  保存解密文件: "Save decrypted file",
  再次保存解密文件: "Save decrypted file again",
  暂停接收: "Pause download",
  取消保存: "Cancel saving",
  "解密与 SHA-256 校验已完成。请在浏览器下载列表或所选目录确认保存结果。":
    "Decryption and SHA-256 verification complete. Check your browser’s downloads or the selected folder to confirm the file was saved.",
  "分块接收密文后，在浏览器校验、解密并流式写入文件。请保持页面打开；刷新后可继续接收，同一有效会话不重复扣次。":
    "Encrypted parts are verified, decrypted, and streamed to a file in this browser. Keep this page open. After a refresh, you can resume within the same valid session without using another slot.",
  "大文件需要足够的本机空间临时保存一份密文，以及保存最终文件的空间。缓存仅存于此浏览器；清理网站数据会移除续传记录。":
    "Large files need local space for both a temporary encrypted copy and the final file. The cache is stored only in this browser. Clearing site data removes resume records.",
  "浏览器如询问是否允许长期存储，可允许以降低续传缓存被自动清除的风险；暂不回答或拒绝均不阻止本次下载。":
    "If your browser asks for persistent storage, allowing it reduces the risk of automatic cache removal. You can still download if you dismiss or deny the request.",
  清除本机续传缓存: "Clear local resume cache",
  建立新的下载会话: "Start a new download session",
  "下载次数已用完或会话失效，请联系分享者。":
    "The download limit has been reached or the session has expired. Contact the sender.",
  解锁加密分享: "Unlock encrypted share",
  "密码与链接密钥共同在此浏览器解密，服务器不会收到解密密钥。":
    "The password and link key decrypt this file in your browser. The server never receives the decryption key.",
  "正在本机解密…": "Decrypting locally…",
  "无法继续获取密文，请联系分享者。":
    "Encrypted data is no longer available. Contact the sender.",
  链接缺少解密密钥: "Decryption key missing from link",
  "请向分享者索取完整链接，包含 # 后的全部内容。服务器无法恢复丢失的密钥。":
    "Ask the sender for the complete link, including everything after #. The server cannot recover lost keys.",
  "正在打开加密分享…": "Opening encrypted share…",
  "端到端加密 · 文件密钥留在浏览器":
    "End-to-end encryption · File keys stay in your browser",
  "登录已失效，请重新验证身份": "Your login has expired. Please sign in again",
  "服务响应不正确，请稍后重试":
    "Invalid server response. Please try again later",
  "请求失败，请重试": "Request failed. Please try again",
  "请求超时，请检查网络后重试。已提交的操作可能已经生效。":
    "Request timed out. Check your connection and retry. Submitted changes may already have taken effect.",
  可下载: "Available",
  已过期: "Expired",
  次数已用完: "Download limit reached",
  已撤销: "Revoked",
  等待清理: "Pending cleanup",
  已清理: "Cleaned up",
  文件不可用: "File unavailable",
  "清除 {0} 条已清理记录？": "Clear {0} cleaned-up records?",
  "第 {0} 页": "Page {0}",
  "Parcel · 临时文件分享": "Parcel · Temporary file sharing",
  "Parcel，自托管临时文件分享。上传，分享，到期自动清理。":
    "Parcel, self-hosted temporary file sharing. Upload, share, and clean up automatically on expiry.",
};
