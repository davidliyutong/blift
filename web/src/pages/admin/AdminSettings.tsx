import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Banner, Button, ClipboardText, Input, SensitiveInput, Switch } from "@cloudflare/kumo";
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api, type Settings, type SettingsPatch } from "@/api";
import { useI18n } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { GiB } from "@/lib/format";
import { toast } from "@/lib/toast";
import { ErrorState, Loading, Page, Section } from "@/components/Page";
import { MfaBanner } from "@/components/MfaBanner";

export function AdminSettingsPage() {
  const { t } = useI18n();
  const settings = useAsync(() => api.admin.settings(), []);
  return (
    <Page title={t("settings.title")} description={t("settings.subtitle")} wide={false}>
      <MfaBanner />
      {settings.error != null && <ErrorState error={settings.error} onRetry={settings.reload} />}
      {!settings.data ? (
        settings.loading && <Loading />
      ) : (
        <>
          <SiteSection s={settings.data} onSaved={(s) => settings.setData(() => s)} />
          <OidcSection s={settings.data} onSaved={(s) => settings.setData(() => s)} />
          <GcSection s={settings.data} onSaved={(s) => settings.setData(() => s)} />
        </>
      )}
    </Page>
  );
}

function useSave(onSaved: (s: Settings) => void) {
  const { t, errMsg } = useI18n();
  const { refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const save = async (patch: SettingsPatch) => {
    setBusy(true);
    try {
      const s = await api.admin.saveSettings(patch);
      onSaved(s);
      toast.success(t("settings.saved"));
      refresh().catch(() => undefined); // site name / OIDC button live in /api/info
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, save };
}

function SaveRow({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children?: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-kumo-hairline pt-4">
      <Button type="submit" variant="primary" loading={busy} disabled={disabled}>
        {t("common.save")}
      </Button>
      {children}
    </div>
  );
}

function SiteSection({ s, onSaved }: { s: Settings; onSaved: (s: Settings) => void }) {
  const { t } = useI18n();
  const { busy, save } = useSave(onSaved);
  const [name, setName] = useState(s.site.name);
  const [quota, setQuota] = useState(s.site.default_quota_bytes < 0 ? "0" : String(+(s.site.default_quota_bytes / GiB).toFixed(2)));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const gib = Number(quota);
    save({ site: { name: name.trim(), default_quota_bytes: gib > 0 ? Math.round(gib * GiB) : -1 } });
  };

  return (
    <Section title={t("settings.site")}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Input label={t("settings.siteName")} value={name} onChange={(e) => setName(e.target.value)} required />
          <Input
            label={`${t("settings.defaultQuota")} (GiB)`}
            description={t("settings.defaultQuotaHint")}
            type="number"
            min={0}
            step="any"
            value={quota}
            onChange={(e) => setQuota(e.target.value)}
          />
        </div>
        <SaveRow busy={busy} disabled={!name.trim()} />
      </form>
    </Section>
  );
}

function OidcSection({ s, onSaved }: { s: Settings; onSaved: (s: Settings) => void }) {
  const { t, errMsg } = useI18n();
  const { busy, save } = useSave(onSaved);
  const [o, setO] = useState({ ...s.oidc, client_secret: "" });
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string; detail?: string } | null>(null);

  useEffect(() => setO({ ...s.oidc, client_secret: "" }), [s.oidc]);

  const set = <K extends keyof typeof o>(k: K, v: (typeof o)[K]) => setO((x) => ({ ...x, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save({
      oidc: {
        enabled: o.enabled,
        issuer: o.issuer.trim(),
        client_id: o.client_id.trim(),
        scopes: o.scopes.trim(),
        button_label: o.button_label.trim(),
        admin_group: o.admin_group.trim(),
        ...(o.client_secret ? { client_secret: o.client_secret } : {}),
      },
    });
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.admin.testOidc(o.issuer.trim());
      const algs = r.discovery?.id_token_signing_alg_values_supported;
      setTest(
        r.ok
          ? {
              ok: true,
              text: t("settings.discoveryOk"),
              detail: Array.isArray(algs) ? `id_token_signing_alg_values_supported: ${algs.join(", ")}` : undefined,
            }
          : { ok: false, text: t("settings.discoveryFail", { error: r.error ?? "" }) },
      );
    } catch (e) {
      setTest({ ok: false, text: errMsg(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section title={t("settings.oidc")} description={t("settings.oidcDesc")}>
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Switch label={t("settings.oidcEnabled")} checked={o.enabled} onCheckedChange={(v) => set("enabled", v)} />
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("settings.redirectUri")}</span>
          <ClipboardText text={o.redirect_uri} size="base" />
          <span className="text-xs text-kumo-subtle">{t("settings.redirectUriHint")}</span>
        </div>
        <Input
          label={t("settings.issuer")}
          description={t("settings.issuerHint")}
          value={o.issuer}
          onChange={(e) => set("issuer", e.target.value)}
          placeholder="https://auth.example.com/application/o/blift/"
          className="font-mono"
          required={o.enabled}
        />
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Input
            label={t("settings.clientId")}
            value={o.client_id}
            onChange={(e) => set("client_id", e.target.value)}
            className="font-mono"
            required={o.enabled}
          />
          <SensitiveInput
            label={t("settings.clientSecret")}
            description={s.oidc.client_secret_set ? t("settings.clientSecretSet") : undefined}
            value={o.client_secret}
            onValueChange={(v) => set("client_secret", v)}
            autoComplete="off"
          />
          <Input
            label={t("settings.scopes")}
            value={o.scopes}
            onChange={(e) => set("scopes", e.target.value)}
            placeholder="openid profile email"
            className="font-mono"
          />
          <Input
            label={t("settings.buttonLabel")}
            value={o.button_label}
            onChange={(e) => set("button_label", e.target.value)}
            placeholder="Authentik"
          />
        </div>
        <Input
          label={t("settings.adminGroup")}
          description={t("settings.adminGroupHint")}
          value={o.admin_group}
          onChange={(e) => set("admin_group", e.target.value)}
          placeholder="blift-admins"
          required={false}
        />
        {test && (
          <Banner
            variant={test.ok ? "default" : "error"}
            icon={test.ok ? <CheckCircleIcon weight="fill" /> : <WarningCircleIcon weight="fill" />}
            title={test.text}
            description={test.detail}
          />
        )}
        <SaveRow busy={busy}>
          <Button type="button" variant="secondary" loading={testing} disabled={!o.issuer.trim()} onClick={runTest}>
            {t("settings.testDiscovery")}
          </Button>
        </SaveRow>
      </form>
    </Section>
  );
}

function GcSection({ s, onSaved }: { s: Settings; onSaved: (s: Settings) => void }) {
  const { t } = useI18n();
  const { busy, save } = useSave(onSaved);
  const [ttl, setTtl] = useState(String(s.gc.pending_upload_ttl_hours));
  const n = Number(ttl);
  return (
    <Section title={t("settings.gc")}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          save({ gc: { pending_upload_ttl_hours: n } });
        }}
      >
        <Input
          className="max-w-xs"
          label={t("settings.pendingTtl")}
          description={t("settings.pendingTtlHint")}
          type="number"
          min={1}
          value={ttl}
          onChange={(e) => setTtl(e.target.value)}
        />
        <SaveRow busy={busy} disabled={!(n >= 1)} />
      </form>
    </Section>
  );
}
