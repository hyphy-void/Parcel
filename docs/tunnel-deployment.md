# Cloudflare Tunnel deployment

Parcel administration and file sharing use the same public HTTPS hostname. The application deployment does not require Tailscale.

| Component | Address |
|---|---|
| Login and administration | `https://parcel.playereconlab.com/login` |
| Public share links | `https://parcel.playereconlab.com/s/<id>` |
| cloudflared origin / Caddy | `127.0.0.1:8080` |
| Parcel backend | `127.0.0.1:8081` |

The Cloudflare published application route uses HTTP service `127.0.0.1:8080`, hostname `parcel.playereconlab.com`, and no path filter. Do not publish the backend directly.

`/etc/parcel/parcel.env`:

```ini
PARCEL_LISTEN_ADDR=127.0.0.1:8081
PARCEL_BASE_URL=https://parcel.playereconlab.com
PARCEL_TRUSTED_PROXIES=127.0.0.1/32
```

The installed Caddy configuration is `/etc/caddy/Caddyfile`. See [the reusable template](../deploy/Caddyfile.tunnel.example), replacing the example hostname. Explicit `bind 127.0.0.1` keeps the origin local without introducing an implicit localhost Host matcher.

Caddy permits the frontend, authentication, administration, uploads, shares, and downloads with the expected Host. Health/readiness and unmatched paths return 403. Management API access still requires Parcel's session authentication; state-changing authenticated actions retain CSRF checks. Parcel validates the public Host/Origin and uses Secure cookies. Caddy forwards Cloudflare's client IP for application rate limiting, sets `Cache-Control: private, no-store`, and does not enable access logs.

The temporary private management listener on 8082 and Tailscale Serve configuration were removed. Existing host-level Tailscale SSH remains a maintenance facility, not part of the Parcel request path.

`parcel`, `caddy`, and `cloudflared` are enabled at boot. No router inbound ports or DDNS are needed. The old UFW exceptions for 80/443 and LAN 8080 were removed; SSH rules were preserved. Files and Parcel password were not changed. Cloudflare terminates public HTTPS. Existing files remain on the Pi; enabling [private R2 storage](r2-storage.md) sends new file content directly between browsers and R2 while retaining this Tunnel for the frontend and permission APIs.

## Verification

Checks were performed from the user's Ubuntu and on the Pi; DMIT was not used.

- Public root/login/admin frontend responds 200.
- Unauthenticated session, admin status, upload lookup and upload creation are denied with 401.
- Public health/readiness are denied with 403.
- Public share frontend/assets respond 200; nonexistent share API responds 404.
- Isolated acceptance with temporary data passed password login, upload, download, Range resume, download counting and revocation. Foreign Origin and unexpected Host are rejected. Production credentials were not used for this test.
- No 8082 or Tailscale 443 management listener remains; Serve reports no configuration.

Some default Python urllib requests were rejected by Cloudflare error 1010 before reaching Caddy; ordinary curl requests reached the expected application routes.

## Recovery

The immediately preceding Caddy configuration is backed up at `/etc/caddy/Caddyfile.before-public-admin` on the Pi. It contains the retired private management configuration; restoring that whole arrangement would also require recreating its Serve entry.

The original LAN/direct-mode configuration backups are in `/etc/parcel/tunnel-backup-20261008-040837/`. Restoring that deployment requires restoring both configuration files and its firewall rules.

Do not commit Tunnel tokens, passwords or runtime data.
