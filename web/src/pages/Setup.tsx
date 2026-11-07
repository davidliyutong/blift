import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router";
import { Banner, Button, Input, SensitiveInput } from "@cloudflare/kumo";
import {
  ArrowRightIcon,
  CheckCircleIcon,
  CircleIcon,
  RocketLaunchIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { api } from "@/api";
import { useI18n } from "@/i18n";
import { useSession } from "@/lib/session";
import { formValues } from "@/lib/form";
import { Card, CardHeader, CenteredLayout } from "@/components/CenteredLayout";

export function SetupPage() {
  const { t, errMsg } = useI18n();
  const { info, setUser, refresh } = useSession();
  const navigate = useNavigate();
  // Fields are uncontrolled (see lib/form.ts); password rules are checked on submit.
  const [invalid, setInvalid] = useState<"short" | "mismatch" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  if (!info.setup_required && !done) return <Navigate to="/" replace />;

  const short = invalid === "short";
  const mismatch = invalid === "mismatch";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const { secret = "", username = "", email = "", password = "", confirm = "" } = formValues(e);
    const problem = password.length < 8 ? "short" : confirm !== password ? "mismatch" : null;
    setInvalid(problem);
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.setup({ secret: secret.trim(), username: username.trim(), password, email: email.trim() || undefined });
      setDone(true);
      setUser(res.user);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    const steps = [t("setup.step.storage"), t("setup.step.cors"), t("setup.step.oidc"), t("setup.step.mfa")];
    return (
      <CenteredLayout title={t("setup.doneTitle")}>
        <Card>
          <CardHeader
            icon={<CheckCircleIcon size={36} weight="fill" className="text-kumo-success" />}
            title={t("setup.doneTitle")}
            subtitle={t("setup.doneSubtitle")}
          />
          <ol className="m-0 mb-6 flex list-none flex-col gap-3 p-0">
            {steps.map((s, i) => (
              <li key={i} className="flex items-start gap-3 text-sm">
                <CircleIcon className="mt-0.5 shrink-0 text-kumo-subtle" />
                <span>{s}</span>
              </li>
            ))}
          </ol>
          <Button variant="primary" className="w-full justify-center" icon={ArrowRightIcon} onClick={() => navigate("/admin/storages")}>
            {t("setup.go")}
          </Button>
        </Card>
      </CenteredLayout>
    );
  }

  return (
    <CenteredLayout width="max-w-[480px]">
      <Card>
        <CardHeader
          icon={<RocketLaunchIcon size={32} weight="duotone" />}
          title={t("setup.title", { name: info.name })}
          subtitle={t("setup.subtitle")}
        />
        <form method="post" className="flex flex-col gap-4" onSubmit={submit}>
          {error != null && <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={errMsg(error)} />}
          <SensitiveInput
            label={t("setup.secret")}
            description={t("setup.secretHint")}
            name="secret"
            required
            autoFocus
          />
          <Input
            label={t("common.username")}
            name="username"
            defaultValue="admin"
            required
            autoComplete="username"
          />
          <Input
            label={t("common.email")}
            type="email"
            name="email"
            autoComplete="email"
            required={false}
          />
          <Input
            label={t("common.password")}
            type="password"
            name="password"
            onChange={() => short && setInvalid(null)}
            required
            autoComplete="new-password"
            error={short ? t("setup.passwordShort") : undefined}
            variant={short ? "error" : "default"}
          />
          <Input
            label={t("setup.confirmPassword")}
            type="password"
            name="confirm"
            onChange={() => mismatch && setInvalid(null)}
            required
            autoComplete="new-password"
            error={mismatch ? t("setup.passwordMismatch") : undefined}
            variant={mismatch ? "error" : "default"}
          />
          <Button type="submit" variant="primary" loading={busy} className="mt-2 w-full justify-center">
            {t("setup.submit")}
          </Button>
        </form>
      </Card>
    </CenteredLayout>
  );
}
