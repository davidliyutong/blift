import type { Lang } from "@/i18n";

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(digits)} ${UNITS[i]}`;
}

export const GiB = 1024 ** 3;

const locale = (lang: Lang) => (lang === "zh" ? "zh-CN" : "en-US");

export function formatDate(ms: number | null | undefined, lang: Lang): string {
  if (!ms) return "—";
  return new Intl.DateTimeFormat(locale(lang), { dateStyle: "medium", timeStyle: "short" }).format(ms);
}

export function formatDay(ms: number, lang: Lang): string {
  return new Intl.DateTimeFormat(locale(lang), { month: "short", day: "numeric" }).format(ms);
}

export function formatRelative(ms: number | null | undefined, lang: Lang): string {
  if (!ms) return "—";
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(locale(lang), { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 864e5],
    ["month", 30 * 864e5],
    ["week", 7 * 864e5],
    ["day", 864e5],
    ["hour", 36e5],
    ["minute", 6e4],
  ];
  for (const [unit, size] of steps) {
    if (abs >= size) return rtf.format(Math.round(diff / size), unit);
  }
  return rtf.format(Math.round(diff / 1000), "second");
}

export function formatNumber(n: number, lang: Lang): string {
  return new Intl.NumberFormat(locale(lang), { notation: n >= 1e5 ? "compact" : "standard" }).format(n);
}

export function displayName(u: { username: string; display_name: string | null } | null | undefined): string {
  if (!u) return "—";
  return u.display_name || u.username;
}

export function randomPassword(len = 12): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
