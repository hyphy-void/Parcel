"use strict";

// Keep the approved typography intact; move each complete line with the scroll.
const hero = document.querySelector(".hero");
if (hero && "IntersectionObserver" in window && "ResizeObserver" in window) {
  const motionPreference = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  );
  let heroVisible = false;
  let travel = 1;
  let frame = 0;
  const paintHero = () => {
    frame = 0;
    const progress = Math.min(1, Math.max(0, window.scrollY / travel));
    hero.style.setProperty("--hero-progress", progress.toFixed(4));
  };
  const scheduleHero = () => {
    if (!motionPreference.matches && heroVisible && !frame)
      frame = requestAnimationFrame(paintHero);
  };
  const syncHeroMotion = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    hero.toggleAttribute(
      "data-scroll-motion",
      heroVisible && !motionPreference.matches,
    );
    if (motionPreference.matches) hero.style.removeProperty("--hero-progress");
    else scheduleHero();
  };
  new ResizeObserver(([entry]) => {
    travel = Math.max(1, Math.min(entry.contentRect.height * 0.4, 320));
    scheduleHero();
  }).observe(hero);
  new IntersectionObserver(([entry]) => {
    heroVisible = entry.isIntersecting;
    syncHeroMotion();
  }).observe(hero);
  window.addEventListener("scroll", scheduleHero, { passive: true });
  window.addEventListener("pageshow", scheduleHero);
  motionPreference.addEventListener("change", syncHeroMotion);
}

const chinese = document.documentElement.lang.startsWith("zh");
const text = chinese
  ? {
      invalidURL: "请填写 HTTPS 应用地址，不含路径、端口、查询参数或片段。",
      invalidAccount: "请输入 32 位小写十六进制账户 ID（0–9、a–f）。",
      invalidBucket:
        "请输入 3–63 位小写字母、数字或连字符，首尾须为字母或数字。",
      generated:
        "配置已生成。完成管理员初始化后，先验收加密分享与本机密钥备份。E2EE 不新增服务端密钥。",
      stale: "输入已修改，请重新生成配置后再复制。",
      copied: "已复制。",
      copiedButton: "已复制",
      failedButton: "复制失败",
      copying: "正在复制…",
      copyFailed: "未能复制。上方文本已选中，请使用系统复制命令。",
    }
  : {
      invalidURL:
        "Enter an HTTPS app URL without a path, port, query, or fragment.",
      invalidAccount:
        "Enter a 32-character lowercase hexadecimal account ID (0–9, a–f).",
      invalidBucket:
        "Use 3–63 lowercase letters, digits, or hyphens. Start and end with a letter or digit.",
      generated:
        "Config generated. Finish admin setup, then test encrypted shares and local key backups. E2EE adds no server secret.",
      stale: "Your inputs changed. Generate the config again before copying.",
      copied: "Copied.",
      copiedButton: "Copied",
      failedButton: "Copy failed",
      copying: "Copying…",
      copyFailed:
        "Could not copy. The text above is selected; use your system’s copy command.",
    };

const languageSwitch = document.querySelector("[data-language-switch]");
if (languageSwitch) {
  const target = languageSwitch.getAttribute("href");
  const updateLanguageLink = () =>
    languageSwitch.setAttribute("href", target + window.location.hash);
  updateLanguageLink();
  window.addEventListener("hashchange", updateLanguageLink);
}
for (const date of document.querySelectorAll("[data-review-date]")) {
  date.textContent = new Intl.DateTimeFormat(chinese ? "zh-CN" : "en", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date.dateTime}T00:00:00Z`));
}
const form = document.querySelector("#config-form");
const message = document.querySelector("#config-message");
const result = document.querySelector("#config-result");
const fields = ["origin", "account", "bucket"].map((id) =>
  document.getElementById(id),
);
function clearError(field) {
  field.removeAttribute("aria-invalid");
  document.getElementById(`${field.id}-error`).hidden = true;
}
function showError(field, error) {
  field.setAttribute("aria-invalid", "true");
  const note = document.getElementById(`${field.id}-error`);
  note.textContent = error;
  note.hidden = false;
}
form.hidden = false;
form.addEventListener("input", (event) => {
  if (fields.includes(event.target)) clearError(event.target);
  if (!result.hidden) {
    result.hidden = true;
    message.textContent = text.stale;
    for (const note of result.querySelectorAll(".copy-message"))
      note.textContent = "";
  }
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const [originField, accountField, bucketField] = fields;
  fields.forEach(clearError);
  let url;
  try {
    const raw = originField.value.trim();
    url = new URL(raw);
    // URL.port normalizes :443 away; inspect the authored authority as well.
    const authority = raw.split("/")[2] || "";
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      authority.includes(":") ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      throw new Error(text.invalidURL);
    }
  } catch {
    showError(originField, text.invalidURL);
  }
  const account = accountField.value.trim();
  const bucket = bucketField.value.trim();
  if (!/^[a-f0-9]{32}$/.test(account))
    showError(accountField, text.invalidAccount);
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket))
    showError(bucketField, text.invalidBucket);
  const invalid = fields.find((field) => field.hasAttribute("aria-invalid"));
  if (invalid) {
    result.hidden = true;
    message.textContent = document.getElementById(
      `${invalid.id}-error`,
    ).textContent;
    invalid.focus();
    return;
  }
  const cors = [
    {
      AllowedOrigins: [url.origin],
      AllowedMethods: ["GET", "HEAD", "PUT"],
      AllowedHeaders: ["Content-Type", "Range", "X-Amz-Meta-Parcel-Upload"],
      ExposeHeaders: [
        "ETag",
        "Content-Length",
        "Content-Range",
        "Accept-Ranges",
      ],
      MaxAgeSeconds: 3600,
    },
  ];
  document.querySelector("#cors-output").textContent = JSON.stringify(
    cors,
    null,
    2,
  );
  document.querySelector("#vars-output").textContent =
    `PUBLIC_URL=${url.origin}\nADMIN_AUTH=totp\nR2_ENDPOINT=https://${account}.r2.cloudflarestorage.com\nR2_BUCKET_NAME=${bucket}\nSTORAGE_QUOTA_BYTES=9000000000\nMAX_FILE_BYTES=8589934592\nWORKERS_PLAN=free\nCLEANUP_BATCH_SIZE=1\nACTIVE=false`;
  result.hidden = false;
  message.textContent = text.generated;
  for (const note of result.querySelectorAll(".copy-message"))
    note.textContent = "";
});
for (const button of document.querySelectorAll("[data-copy]")) {
  const label = button.textContent.trim();
  let resetTimer;
  button.hidden = false;
  button.addEventListener("click", async () => {
    clearTimeout(resetTimer);
    const output = document.getElementById(button.dataset.copy);
    const note = button
      .closest("[data-copy-block]")
      .querySelector(".copy-message");
    button.disabled = true;
    delete button.dataset.copyState;
    button.textContent = text.copying;
    note.textContent = text.copying;
    try {
      await navigator.clipboard.writeText(output.textContent);
      button.textContent = text.copiedButton;
      button.insertAdjacentHTML(
        "afterbegin",
        '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6" /></svg>',
      );
      button.dataset.copyState = "copied";
      note.textContent = text.copied;
    } catch {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(output);
      selection.removeAllRanges();
      selection.addRange(range);
      output.parentElement.focus();
      button.textContent = text.failedButton;
      note.textContent = text.copyFailed;
    } finally {
      button.disabled = false;
      resetTimer = setTimeout(() => {
        button.textContent = label;
        delete button.dataset.copyState;
      }, 2000);
    }
  });
}
const contents = document.querySelector(".contents-disclosure");
const narrow = window.matchMedia("(max-width: 1000px)");
const setContents = () => {
  contents.open = !narrow.matches;
};
setContents();
narrow.addEventListener("change", setContents);
const chapterLinks = [...contents.querySelectorAll('a[href^="#"]')];
const chapters = chapterLinks.map((link) => document.querySelector(link.hash));
function openHashTarget() {
  const target = document.getElementById(window.location.hash.slice(1));
  if (target?.matches(".faq-list details")) target.open = true;
}
openHashTarget();
window.addEventListener("hashchange", openHashTarget);
for (const detail of document.querySelectorAll(".faq-list details")) {
  detail.addEventListener("toggle", () => {
    if (detail.open) history.replaceState(null, "", `#${detail.id}`);
    else if (window.location.hash === `#${detail.id}`)
      history.replaceState(null, "", "#faq");
    languageSwitch?.setAttribute(
      "href",
      languageSwitch.getAttribute("href").split("#")[0] + window.location.hash,
    );
  });
}
if ("IntersectionObserver" in window) {
  const visibleChapters = new Set();
  const navigation = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visibleChapters.add(entry.target);
        else visibleChapters.delete(entry.target);
      }
      const active = chapters.find((chapter) => visibleChapters.has(chapter));
      if (active)
        for (const link of chapterLinks) {
          if (link.hash === `#${active.id}`)
            link.setAttribute("aria-current", "location");
          else link.removeAttribute("aria-current");
        }
    },
    { rootMargin: "-5% 0px -55% 0px" },
  );
  chapters.forEach((chapter) => navigation.observe(chapter));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const finishMotion = () => {
    for (const element of document.querySelectorAll(
      ".is-entering, .is-heading-entering, .is-image-entering",
    )) {
      for (const animation of element.getAnimations()) animation.finish();
    }
  };
  reducedMotion.addEventListener("change", finishMotion);
  document.addEventListener("pointerdown", finishMotion, { passive: true });
  document.addEventListener("keydown", finishMotion);
  document.addEventListener("animationend", (event) => {
    if (event.animationName.startsWith("guide-")) {
      event.target.classList.remove(
        "is-entering",
        "is-heading-entering",
        "is-image-entering",
      );
    }
  });
  const entrances = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entrances.unobserve(entry.target);
        if (reducedMotion.matches) continue;
        const image = entry.target.tagName === "IMG";
        const heading = entry.target.matches("h1, h2, h3");
        entry.target.classList.add(
          image
            ? "is-image-entering"
            : heading
              ? "is-heading-entering"
              : "is-entering",
        );
      }
    },
    { threshold: 0.08 },
  );
  document
    .querySelectorAll(
      ".hero h1, .hero-copy > p, .hero .action, .hero-guide-link, .section-heading > *, article h3, .answer > p, .answer img, .verify h2, .verify .lead, .verify li, #faq > h2",
    )
    .forEach((element) => entrances.observe(element));
}
