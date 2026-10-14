# Security

Please do not include credentials, signed download URLs, private files or database snapshots in public issues.

Report suspected vulnerabilities through GitHub's private vulnerability reporting for this repository when available. If it is unavailable, open an issue requesting a private reporting channel without publishing exploit details.

Keep Cloudflare management tokens out of Worker runtime bindings. Scope R2 S3 credentials to the application's private bucket. Preserve and back up SESSION_SECRET separately from D1; replacing it can make existing password-protected shares unreadable.
