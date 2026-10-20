import { useSyncExternalStore } from "react";
import { english } from "./messages.en";

export type Locale = "zh-CN" | "en";
const storageKey = "parcel.language";
let locale: Locale = "zh-CN";
try {
  if (localStorage.getItem(storageKey) === "en") locale = "en";
} catch {
  // Language switching still works when browser storage is unavailable.
}
const listeners = new Set<() => void>();
export const getLocale = () => locale;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale);
}

// Stored notices and server errors keep their original text so they can be
// translated again when the language changes, including interpolated values.
const patterns = Object.keys(english)
  .filter((key) => /\{\d+\}/.test(key))
  .map((key) => ({
    key,
    expression: new RegExp(
      "^" +
        key
          .split(/\{\d+\}/)
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join("([\\s\\S]*?)") +
        "$",
    ),
  }));

export function t(source = "", ...values: (string | number)[]): string {
  let translated = source;
  if (locale === "en") {
    translated = Object.hasOwn(english, source) ? english[source] : source;
    if (translated === source && !values.length) {
      for (const { key, expression } of patterns) {
        const match = expression.exec(source);
        if (!match) continue;
        translated = english[key];
        values = match
          .slice(1)
          .map((value) =>
            Object.hasOwn(english, value) ? english[value] : value,
          );
        break;
      }
    }
  }
  return values.length
    ? translated.replace(/\{(\d+)\}/g, (token, index) =>
        String(values[index] ?? token),
      )
    : translated;
}

function updateDocument() {
  document.documentElement.lang = locale;
  document.title = t("Parcel · 临时文件分享");
  document
    .querySelector('meta[name="description"]')
    ?.setAttribute(
      "content",
      t("Parcel，自托管临时文件分享。上传，分享，到期自动清理。"),
    );
}
function updateLocale(value: Locale) {
  locale = value;
  updateDocument();
  listeners.forEach((listener) => listener());
}
export function setLocale(value: Locale) {
  try {
    localStorage.setItem(storageKey, value);
  } catch {
    /* Keep the in-memory preference. */
  }
  updateLocale(value);
}
window.addEventListener("storage", (event) => {
  if (event.key === storageKey || event.key === null)
    updateLocale(event.newValue === "en" ? "en" : "zh-CN");
});
updateDocument();

export function LanguageSwitcher() {
  const current = useLocale();
  return (
    <button
      type="button"
      className="language-switch text-button"
      onClick={() => setLocale(current === "en" ? "zh-CN" : "en")}
      aria-label={current === "en" ? "切换到中文" : "Switch to English"}
      lang={current === "en" ? "zh-CN" : "en"}
      translate="no"
    >
      {current === "en" ? "中文" : "English"}
    </button>
  );
}
