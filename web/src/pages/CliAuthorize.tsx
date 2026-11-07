import { useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { Banner, Button, Input } from "@cloudflare/kumo";
import { CheckCircleIcon, TerminalWindowIcon, WarningCircleIcon, XCircleIcon } from "@phosphor-icons/react";
import { api } from "@/api";
import { useI18n } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { useUser } from "@/lib/session";
import { displayName, formatRelative } from "@/lib/format";
import { Card, CardHeader, CenteredLayout } from "@/components/CenteredLayout";
import { Detail, Loading } from "@/components/Page";

export function CliAuthorizePage() {
  const { t, lang, errMsg } = useI18n();
  const user = useUser();
  const [params, setParams] = useSearchParams();
  const code = (params.get("code") ?? "").toUpperCase();
  const [input, setInput] = useState("");
  const [result, setResult] = useState<"approved" | "denied" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const req = useAsync(() => (code ? api.cli.get(code) : Promise.resolve(null)), [code]);

  const act = async (approve: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await (approve ? api.cli.approve(code) : api.cli.deny(code));
      setResult(approve ? "approved" : "denied");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const lookup = (e: FormEvent) => {
    e.preventDefault();
    const c = input.trim().toUpperCase();
    if (c) setParams({ code: c });
  };

  let body;
  if (result) {
    body = (
      <div className="flex flex-col items-center gap-3 py-4 text-center">
        {result === "approved" ? (
          <CheckCircleIcon size={48} weight="fill" className="text-kumo-success" />
        ) : (
          <XCircleIcon size={48} weight="fill" className="text-kumo-subtle" />
        )}
        <p className="m-0 font-medium">{result === "approved" ? t("cli.approved") : t("cli.denied")}</p>
      </div>
    );
  } else if (!code) {
    body = (
      <form className="flex flex-col gap-4" onSubmit={lookup}>
        <Input
          label={t("cli.enterCode")}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="XXXX-XXXX"
          className="font-mono tracking-widest uppercase"
          autoFocus
        />
        <Button type="submit" variant="primary" className="w-full justify-center">
          {t("cli.lookup")}
        </Button>
      </form>
    );
  } else if (req.loading) {
    body = <Loading />;
  } else if (!req.data || req.data.status !== "pending" || req.data.expires_at < Date.now()) {
    body = <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={t("cli.invalid")} />;
  } else {
    body = (
      <div className="flex flex-col gap-5">
        {error != null && <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={errMsg(error)} />}
        <div>
          <p className="m-0 mb-3 text-sm text-kumo-subtle">{t("cli.code")}</p>
          <div className="rounded-lg bg-kumo-recessed py-4 text-center font-mono text-3xl font-semibold tracking-[0.25em]">
            {req.data.user_code}
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <Detail label={t("cli.client")}>{req.data.client_name}</Detail>
          <Detail label={t("cli.requested")}>{formatRelative(req.data.created_at, lang)}</Detail>
          <Detail label={t("nav.account")}>{displayName(user)}</Detail>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1 justify-center" disabled={busy} onClick={() => act(false)}>
            {t("cli.deny")}
          </Button>
          <Button variant="primary" className="flex-1 justify-center" loading={busy} onClick={() => act(true)}>
            {t("cli.approve")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <CenteredLayout title={t("cli.title")}>
      <Card>
        <CardHeader
          icon={<TerminalWindowIcon size={32} weight="duotone" />}
          title={t("cli.title")}
          subtitle={t("cli.subtitle")}
        />
        {body}
      </Card>
    </CenteredLayout>
  );
}
