# Deployment guide

Buildless static Cloudflare Pages site. Publish `docs/site/` to the `parcel-guide` Pages project (production branch: main). No R2 binding or runtime credentials are required. Images are tracked WebP files and shipped with the page.

The default page (`index.html`) is English. The translation icon links to the Chinese page (`zh.html`); both pages work without JavaScript. Language links preserve the current section when JavaScript is enabled. Keep instructions, captions and image descriptions in sync in both HTML files. `guide.js` selects configuration-tool messages from the document language.

The guide uses a shared orange, ink, and paper palette: a full-screen opening, orange chapter index and configuration form, dark code results and launch checklist, and orange expanded FAQ answers. The configuration form stacks fields in reading order; generated code has keyboard-scrollable regions and nearby copy buttons.

The guide includes a sticky chapter index on desktop and a native collapsible index on smaller screens. FAQ links use stable `#faq-*` fragments and preserve the selected question when switching languages. The configuration generator runs only in the browser: it validates fields inline, hides stale output after edits, and selects text for manual copying if clipboard access is denied. Without JavaScript, the complete instructions, image links, chapter index, and CORS example remain available. Entrance animations run once and honor reduced motion. The two hero headline lines translate gently with scrolling, return to their original positions at the top, and stop updating outside the viewport. Their font size, weight, and shape remain unchanged; reduced motion disables the scroll effect too.

After installing the existing web dependencies and Playwright Chromium, run `node --test scripts/tests/guide.test.mjs scripts/tests/guide-browser.test.mjs`. Browser checks cover both languages, invalid origins and resource names, generated CORS/variables, clipboard success/fallback, stale results, keyboard access, FAQ deep links, reduced motion, no-JavaScript reading, and widths from 320 to 1440 pixels.

CI runs the browser checks after installing Chromium. After committing and publishing, run `node scripts/verify-guide-production.mjs HEAD` to compare every public guide file's SHA-256 with its committed Git blob, check the deployed security headers, and verify the custom 404. This reads production without changing it and avoids checkout line-ending differences. The guide is a direct-upload Pages project: pushing the application repository alone does not publish new guide assets; upload a changed guide, then repeat this check. If the deployed files already match the commit, another upload is unnecessary.

Manual upload: create a ZIP whose root contains index.html, zh.html, style.css, guide.js, _headers, 404.html and images/. Upload it using Workers & Pages → Create application → Pages → Upload assets. Do not include this README or original screenshots.

CLI (Pages-authorized Cloudflare login required):

```sh
node cloudflare/node_modules/wrangler/bin/wrangler.js pages deploy docs/site --project-name parcel-guide --branch main
```

Screenshots were replaced on 2026-10-19 with user-reviewed PNGs from the actual Cloudflare dashboard, including the corrected R2 token form (Object Read & Write, specific parcel bucket). Account and identity fields are permanently covered with solid fills and labeled with example values (example.com, admin@example.com, YOUR_ACCESS_AUD, YOUR_TEAM, YOUR_ACCOUNT_ID and YOUR_RESOURCE_CONFIG_JSON). Never treat placeholder labels as real configuration. Review each final image before publication. Secret fields are encrypted or empty. Run `python scripts/prepare-tutorial-images.py /path/to/deploy-pic` with Pillow to encode all eight images as lossless WebP at their original dimensions, without source metadata. The script validates the reviewed source dimensions before applying masks; pass `--font` to use a different TrueType font when Segoe UI is unavailable. Raw PNGs stay outside this directory. `scripts/redact-tutorial.py` belongs to the older capture workflow and must not be run to regenerate the new screenshots.

The `template-build.webp` filename is retained for link compatibility, but now shows an existing production instance using `build:production` / `deploy:production`. Both captions distinguish that from new button deployments using `build` / `deploy`. The CORS screenshot omits `X-Amz-Meta-Parcel-Upload`; the caption directs readers to the complete configuration generator below it.
