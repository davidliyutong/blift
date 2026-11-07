import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@cloudflare/kumo";
import { CloudSlashIcon } from "@phosphor-icons/react";
import { api, ApiError, onUnauthorized, type Info, type User } from "@/api";
import { useI18n } from "@/i18n";

interface SessionCtx {
  info: Info;
  user: User | null;
  mfaPending: boolean;
  /** Re-fetch /api/auth/me (and /api/info). */
  refresh: () => Promise<void>;
  setUser: (u: User | null, mfaPending?: boolean) => void;
  logout: () => Promise<void>;
}

const Ctx = createContext<SessionCtx | null>(null);

export function SessionProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [user, setUserState] = useState<User | null>(null);
  const [mfaPending, setMfaPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    const [i, me] = await Promise.all([
      api.info(),
      api.auth.me().catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          return e.code === "mfa_required" ? ("mfa" as const) : null;
        }
        throw e;
      }),
    ]);
    setInfo(i);
    if (me === "mfa") {
      setUserState(null);
      setMfaPending(true);
    } else if (me) {
      setUserState(me.user);
      setMfaPending(me.mfa_pending);
    } else {
      setUserState(null);
      setMfaPending(false);
    }
  }, []);

  useEffect(() => {
    refresh().catch(setError);
  }, [refresh]);

  useEffect(
    () =>
      onUnauthorized((e) => {
        setUserState(null);
        setMfaPending(e.code === "mfa_required");
      }),
    [],
  );

  const value = useMemo<SessionCtx | null>(
    () =>
      info && {
        info,
        user,
        mfaPending,
        refresh,
        setUser: (u, pending = false) => {
          setUserState(u);
          setMfaPending(pending);
        },
        logout: async () => {
          await api.auth.logout().catch(() => undefined);
          setUserState(null);
          setMfaPending(false);
        },
      },
    [info, user, mfaPending, refresh],
  );

  if (error) return <BootError error={error} onRetry={() => (setError(null), refresh().catch(setError))} />;
  if (!value) return <>{fallback}</>;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useSession outside SessionProvider");
  return ctx;
}

/** Current user; only use inside routes guarded by RequireAuth. */
export function useUser(): User {
  const { user } = useSession();
  if (!user) throw new Error("useUser without user");
  return user;
}

function BootError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t, errMsg } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <CloudSlashIcon size={40} weight="duotone" className="text-kumo-subtle" />
      <p className="m-0 font-medium">{errMsg(error)}</p>
      <Button variant="secondary" onClick={onRetry}>
        {t("common.retry")}
      </Button>
    </div>
  );
}
