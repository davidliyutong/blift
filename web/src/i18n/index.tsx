import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { KumoLocaleProvider } from "@cloudflare/kumo";
import { ApiError } from "@/api/client";
import { en, type Dict } from "./en";
import { zh } from "./zh";

export type Lang = "en" | "zh";
export type TKey = keyof Dict;
export type TFunc = (key: TKey, vars?: Record<string, string | number>) => string;

const dicts: Record<Lang, Dict> = { en, zh };
const STORAGE_KEY = "blift.lang";

function detect(): Lang {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "en" || saved === "zh") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function format(lang: Lang, key: TKey, vars?: Record<string, string | number>): string {
  const s = dicts[lang][key] ?? en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : s;
}

interface I18nCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFunc;
  /** Human message for any thrown error (translates API error codes). */
  errMsg: (e: unknown) => string;
}

const Ctx = createContext<I18nCtx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detect);

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    localStorage.setItem(STORAGE_KEY, l);
    setLangState(l);
  }, []);

  const value = useMemo<I18nCtx>(() => {
    const t: TFunc = (key, vars) => format(lang, key, vars);
    const errMsg = (e: unknown) => {
      if (e instanceof ApiError) {
        const key = `err.${e.code}` as TKey;
        if (key in en) {
          const base = t(key);
          // storage / oidc errors carry useful details from the server
          return e.code === "storage_error" || e.code === "oidc_error" || e.code === "bad_request"
            ? `${base}: ${e.message}`
            : base;
        }
        return e.message;
      }
      return e instanceof Error ? e.message : String(e);
    };
    return { lang, setLang, t, errMsg };
  }, [lang, setLang]);

  return (
    <Ctx.Provider value={value}>
      <KumoLocaleProvider
        translations={{
          label: { optional: value.t("common.optional") },
          layerDialog: { close: value.t("common.close"), cancel: value.t("common.cancel") },
        }}
      >
        {children}
      </KumoLocaleProvider>
    </Ctx.Provider>
  );
}

export function useI18n(): I18nCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useI18n outside I18nProvider");
  return ctx;
}

export function useT(): TFunc {
  return useI18n().t;
}
