import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemePref = "light" | "dark" | "system";
const KEY = "blift.theme";

interface ThemeCtx {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  isDark: boolean;
}

const Ctx = createContext<ThemeCtx | null>(null);
const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(() => (localStorage.getItem(KEY) as ThemePref) || "system");
  const [systemDark, setSystemDark] = useState(() => media().matches);

  useEffect(() => {
    const m = media();
    const fn = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    m.addEventListener("change", fn);
    return () => m.removeEventListener("change", fn);
  }, []);

  const isDark = pref === "dark" || (pref === "system" && systemDark);

  useEffect(() => {
    document.documentElement.setAttribute("data-mode", isDark ? "dark" : "light");
  }, [isDark]);

  const value = useMemo(
    () => ({
      pref,
      isDark,
      setPref: (p: ThemePref) => {
        localStorage.setItem(KEY, p);
        setPrefState(p);
      },
    }),
    [pref, isDark],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme outside ThemeProvider");
  return ctx;
}
