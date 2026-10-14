# Deployment guide

Buildless static Cloudflare Pages site. Publish `docs/site/` to the `parcel-guide` Pages project (production branch: main). No R2 binding or runtime credentials are required. Images are tracked WebP files and shipped with the page.

Manual upload: create a ZIP whose root contains index.html, style.css, guide.js, _headers, 404.html and images/. Upload it using Workers & Pages → Create application → Pages → Upload assets. Do not include this README or original screenshots.

CLI (Pages-authorized Cloudflare login required):

```sh
node cloudflare/node_modules/wrangler/bin/wrangler.js pages deploy docs/site --project-name parcel-guide --branch main
```

Screenshots were captured on 2026-10-14 from the actual Cloudflare dashboard. Account email, account identifiers, Access AUD/team domain, and instance-specific values are covered with opaque rectangles before WebP encoding. Secret fields are left encrypted or empty. Raw captures and coordinates remain in ignored `.parcel-tutorial/`; `scripts/redact-tutorial.py` uses Pillow to crop and flatten reviewed captures. Inspect every published image after converting it; browser full-page capture can shift column widths.
