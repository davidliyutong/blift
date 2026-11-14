import { useRef, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { Banner, Button, Collapsible, Input, LinkButton } from "@cloudflare/kumo";
import { ShieldCheckIcon, SignInIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api } from "@/api";
import { useI18n, type TKey } from "@/i18n";
import { useSession } from "@/lib/session";
import { digits, formValues } from "@/lib/form";
import { Card, CardHeader, CenteredLayout } from "@/components/CenteredLayout";

function safeRedirect(r: string | null): string {
  return r && r.startsWith("/") && !r.startsWith("//") ? r : "/projects";
}

export function LoginPage() {
  const { t, errMsg } = useI18n();
  const { info, user, mfaPending, setUser } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const redirect = safeRedirect(params.get("redirect"));
  const urlError = params.get("error");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The code form submits itself once complete, and a password manager may click Verify right
  // after filling it: send one request at a time (state is too slow to catch the second submit).
  const verifying = useRef(false);
  // An SSO failure (?error=...) must not linger once the user moves on to local sign-in.
  const [urlErrorSeen, setUrlErrorSeen] = useState(false);

  if (user && !mfaPending) return <Navigate to={redirect} replace />;
  const mfaStep = mfaPending || params.get("mfa") === "1";

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setUrlErrorSeen(true);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const login = (e: FormEvent) => {
    e.preventDefault();
    const { username = "", password = "" } = formValues(e);
    run(async () => {
      const res = await api.auth.login(username.trim(), password);
      if (res.mfa_required) {
        setUser(null, true);
      } else {
        setUser(res.user);
        navigate(redirect, { replace: true });
      }
    });
  };

  const verify = (e: FormEvent) => {
    e.preventDefault();
    if (verifying.current) return;
    verifying.current = true;
    const code = digits(formValues(e).code);
    run(async () => {
      const res = await api.auth.mfa(code);
      setUser(res.user);
      navigate(redirect, { replace: true });
    }).finally(() => {
      verifying.current = false;
    });
  };

  const errorText =
    error != null ? errMsg(error) : urlError && !urlErrorSeen ? (t(`err.${urlError}` as TKey) ?? urlError) : null;
  const errorBanner = errorText && (
    <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={errorText} />
  );

  if (mfaStep) {
    return (
      <CenteredLayout title={t("login.mfaTitle")}>
        <Card>
          <CardHeader
            icon={<ShieldCheckIcon size={32} weight="duotone" />}
            title={t("login.mfaTitle")}
            subtitle={t("login.mfaSubtitle")}
          />
          <form method="post" className="flex flex-col gap-4" onSubmit={verify}>
            {errorBanner}
            <Input
              label={t("login.mfaCode")}
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              className="font-mono tracking-[0.3em]"
              autoFocus
              required
              // Submit as soon as the code is complete, typed or filled in by a password manager.
              // onInput, not onChange: React drops change events for values set from a script.
              onInput={(e) => {
                const input = e.currentTarget;
                if (digits(input.value).length === 6) input.form?.requestSubmit();
              }}
            />
            <Button type="submit" variant="primary" loading={busy} className="w-full justify-center">
              {t("login.verify")}
            </Button>
          </form>
          {/* Keep this outside the form and without "sign in" in its label: 1Password auto-submits
              a filled code by clicking the form's most sign-in-like button, which used to be this
              one, and that signed the user out instead. */}
          <Button
            type="button"
            variant="ghost"
            className="mt-2 w-full justify-center"
            onClick={async () => {
              await api.auth.logout().catch(() => undefined);
              setUser(null, false);
              navigate(`/login?redirect=${encodeURIComponent(redirect)}`, { replace: true });
            }}
          >
            {t("login.useOther")}
          </Button>
        </Card>
      </CenteredLayout>
    );
  }

  const localForm = (
    <form method="post" className="flex flex-col gap-4" onSubmit={login}>
      <Input
        label={t("common.username")}
        name="username"
        autoComplete="username"
        required
        autoFocus={!info.oidc_enabled}
      />
      <Input
        label={t("common.password")}
        type="password"
        name="password"
        autoComplete="current-password"
        required
      />
      <Button type="submit" variant={info.oidc_enabled ? "secondary" : "primary"} loading={busy} className="w-full justify-center">
        {t("login.submit")}
      </Button>
    </form>
  );

  return (
    <CenteredLayout title={t("login.submit")}>
      <Card>
        <CardHeader title={t("login.title", { name: info.name })} />
        <div className="flex flex-col gap-4">
          {errorBanner}
          {info.oidc_enabled ? (
            <>
              <LinkButton
                href={info.public_url + api.auth.oidcStartUrl(redirect)}
                variant="primary"
                size="lg"
                icon={SignInIcon}
                className="w-full justify-center"
              >
                {t("login.sso", { label: info.oidc_button_label || "SSO" })}
              </LinkButton>
              {/* SSO just failed: offer the local form straight away */}
              <Collapsible.Root defaultOpen={!!error || !!urlError}>
                <Collapsible.DefaultTrigger>{t("login.or")}</Collapsible.DefaultTrigger>
                <Collapsible.DefaultPanel>
                  <p className="mt-0 mb-4 text-xs text-kumo-subtle">{t("login.localOnly")}</p>
                  {localForm}
                </Collapsible.DefaultPanel>
              </Collapsible.Root>
            </>
          ) : (
            localForm
          )}
        </div>
      </Card>
    </CenteredLayout>
  );
}
