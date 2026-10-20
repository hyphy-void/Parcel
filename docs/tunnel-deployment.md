# Current deployment guide

The former Tunnel/Go deployment is no longer the deployment path documented for the live service. Use **Workers + D1 + private R2**, with **administrator password + TOTP** and browser end-to-end file encryption.

Follow the [current deployment and update guide](v3-deployment.md) or the [English illustrated guide](https://parcelwiki.pages.dev/). These cover enrollment, encrypted transfers, key backups, and recovery.

The independent Go/origin compatibility implementation retains its older protocol; it does not provide the current Cloudflare deployment TOTP or file E2EE and cannot take over Cloudflare deployment ciphertext. Historical configuration remains in Git history, not as a current deployment or rollback recipe.
