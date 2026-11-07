import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router";
import QRCode from "qrcode";
import { Badge, Banner, Button, Checkbox, ClipboardText, CodeBlock, Empty, Input, LayerCard, Select, Table } from "@cloudflare/kumo";
import { KeyIcon, PlusIcon, ShieldCheckIcon, ShieldSlashIcon, TerminalWindowIcon, WarningIcon } from "@phosphor-icons/react";
import { api, type ApiKey } from "@/api";
import { useI18n, type Lang } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { useSession, useUser } from "@/lib/session";
import { useTheme, type ThemePref } from "@/lib/theme";
import { formatDate, formatRelative } from "@/lib/format";
import { toast } from "@/lib/toast";
import { digits, formValues } from "@/lib/form";
import { Detail, ErrorState, Loading, Page, Section } from "@/components/Page";
import { FormDialog } from "@/components/Dialogs";
import { LANGS } from "@/components/Preferences";
import { QuotaMeter } from "@/pages/Projects";

export function AccountPage() {
  const { t, lang, setLang } = useI18n();
  const user = useUser();
  const { pref, setPref } = useTheme();
  const { hash } = useLocation();

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ behavior: "smooth" });
  }, [hash]);

  return (
    <Page title={t("account.title")} description={t("account.subtitle")} wide={false}>
      <Section title={t("account.profile")}>
        <div className="flex flex-col gap-3">
          <Detail label={t("common.username")}>{user.username}</Detail>
          <Detail label={t("account.displayName")}>{user.display_name ?? "—"}</Detail>
          <Detail label={t("common.email")}>{user.email ?? "—"}</Detail>
          <Detail label={t("account.role")}>
            <span className="flex flex-wrap gap-1.5">
              <Badge variant={user.role === "admin" ? "orange" : "neutral"}>{t(`role.${user.role}`)}</Badge>
              {user.oidc_linked && <Badge variant="blue">{t("account.sso")}</Badge>}
            </span>
          </Detail>
          <Detail label={t("account.memberSince")}>{formatDate(user.created_at, lang)}</Detail>
          <div className="max-w-md pt-2">
            <QuotaMeter used={user.used_bytes} quota={user.quota_bytes} label={t("account.usage")} />
          </div>
        </div>
      </Section>

      <Section title={t("account.preferences")}>
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Select
            label={t("nav.language")}
            hideLabel={false}
            className="w-full"
            value={lang}
            onValueChange={(v) => setLang(v as Lang)}
            items={Object.fromEntries(LANGS.map((l) => [l.value, l.label]))}
          />
          <Select
            label={t("nav.theme")}
            hideLabel={false}
            className="w-full"
            value={pref}
            onValueChange={(v) => setPref(v as ThemePref)}
            items={{
              light: t("nav.theme.light"),
              dark: t("nav.theme.dark"),
              system: t("nav.theme.system"),
            }}
          />
        </div>
      </Section>

      <TotpSection />
      {user.has_password && <PasswordSection />}
      <SessionsSection />
      <CliSection />
      <ApiKeysSection />
    </Page>
  );
}

function TotpSection() {
  const { t } = useI18n();
  const user = useUser();
  const { refresh } = useSession();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [starting, setStarting] = useState(false);

  const start = async () => {
    setStarting(true);
    try {
      const r = await api.auth.totpSetup();
      const qr = await QRCode.toDataURL(r.otpauth_url, { margin: 1, width: 192 });
      setSetup({ secret: r.secret, qr });
    } finally {
      setStarting(false);
    }
  };

  const codeInput = (
    <Input
      label={t("login.mfaCode")}
      name="code"
      required
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="123456"
      className="font-mono tracking-[0.3em]"
      autoFocus
    />
  );

  return (
    <div id="security">
      <Section title={t("account.security")}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex max-w-lg items-start gap-3">
            {user.totp_enabled ? (
              <ShieldCheckIcon size={24} weight="duotone" className="shrink-0 text-kumo-success" />
            ) : (
              <ShieldSlashIcon size={24} weight="duotone" className="shrink-0 text-kumo-subtle" />
            )}
            <p className="m-0 text-sm text-kumo-subtle">
              {user.totp_enabled ? t("account.totpOn") : t("account.totpOff")}
            </p>
          </div>
          {user.totp_enabled ? (
            <Button variant="secondary-destructive" onClick={() => setDisabling(true)}>
              {t("account.totpDisable")}
            </Button>
          ) : (
            <Button variant="primary" loading={starting} onClick={start}>
              {t("account.totpEnable")}
            </Button>
          )}
        </div>
      </Section>

      <FormDialog
        open={setup != null}
        onOpenChange={(o) => !o && setSetup(null)}
        title={t("account.totpEnable")}
        submitLabel={t("login.verify")}
        onSubmit={async (v) => {
          await api.auth.totpEnable(digits(v.code));
          setSetup(null);
          await refresh();
          toast.success(t("account.totpEnabled"));
        }}
      >
        <p className="m-0 text-sm text-kumo-subtle">{t("account.totpScan")}</p>
        {setup && (
          <div className="flex flex-col items-center gap-3">
            <img src={setup.qr} alt="TOTP QR" width={192} height={192} className="rounded-lg bg-white p-2 ring ring-kumo-line" />
            <span className="text-xs text-kumo-subtle">{t("account.totpSecret")}</span>
            <ClipboardText text={setup.secret} size="sm" />
          </div>
        )}
        {codeInput}
      </FormDialog>

      <FormDialog
        open={disabling}
        onOpenChange={setDisabling}
        title={t("account.totpDisable")}
        description={t("account.totpDisablePrompt")}
        submitLabel={t("account.totpDisable")}
        submitVariant="destructive"
        size="base"
        onSubmit={async (v) => {
          await api.auth.totpDisable(digits(v.code));
          setDisabling(false);
          await refresh();
          toast.success(t("account.totpDisabled"));
        }}
      >
        {codeInput}
      </FormDialog>
    </div>
  );
}

function PasswordSection() {
  const { t, errMsg } = useI18n();
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const { current_password = "", new_password = "" } = formValues(e);
    if (new_password.length < 8) return toast.error(t("setup.passwordShort"));
    setBusy(true);
    try {
      await api.auth.password({ current_password, new_password });
      form.reset();
      toast.success(t("account.passwordChanged"));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("account.password")} description={t("account.passwordDesc")}>
      <form method="post" className="grid max-w-xl items-start gap-4 sm:grid-cols-2" onSubmit={submit}>
        <Input
          label={t("account.currentPassword")}
          type="password"
          name="current_password"
          autoComplete="current-password"
          required
        />
        <Input
          label={t("account.newPassword")}
          type="password"
          name="new_password"
          autoComplete="new-password"
          description={t("setup.passwordShort")}
          required
        />
        <div>
          <Button type="submit" variant="primary" loading={busy}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Section>
  );
}

function SessionsSection() {
  const { t, lang, errMsg } = useI18n();
  const sessions = useAsync(() => api.auth.sessions().then((r) => r.sessions), []);
  return (
    <Section title={t("account.sessions")} description={t("account.sessionsDesc")} bodyClassName="p-0">
      {sessions.error != null && (
        <div className="p-5">
          <ErrorState error={sessions.error} onRetry={sessions.reload} />
        </div>
      )}
      {sessions.loading && !sessions.data ? (
        <Loading />
      ) : (
        <LayerCard className="rounded-none p-0 ring-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{t("common.name")}</Table.Head>
                <Table.Head className="hidden sm:table-cell">{t("common.created")}</Table.Head>
                <Table.Head>{t("account.lastUsed")}</Table.Head>
                <Table.Head className="hidden md:table-cell">{t("account.expires")}</Table.Head>
                <Table.Head className="w-24" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {(sessions.data ?? []).map((s) => (
                <Table.Row key={s.id}>
                  <Table.Cell>
                    <div className="flex items-center gap-2">
                      <Badge variant={s.kind === "cli" ? "purple" : "neutral"}>
                        {s.kind === "cli" ? t("account.sessionCli") : t("account.sessionWeb")}
                      </Badge>
                      <span className="truncate">{s.name ?? "—"}</span>
                      {s.api_key_name && (
                        <span className="hidden truncate text-xs text-kumo-subtle sm:inline">
                          {t("account.viaKey", { name: s.api_key_name })}
                        </span>
                      )}
                      {s.current && <Badge variant="green">{t("account.sessionCurrent")}</Badge>}
                    </div>
                  </Table.Cell>
                  <Table.Cell className="hidden text-kumo-subtle sm:table-cell">{formatDate(s.created_at, lang)}</Table.Cell>
                  <Table.Cell className="text-kumo-subtle">{formatRelative(s.last_used_at, lang)}</Table.Cell>
                  <Table.Cell className="hidden text-kumo-subtle md:table-cell">
                    {s.expires_at ? formatDate(s.expires_at, lang) : t("common.never")}
                  </Table.Cell>
                  <Table.Cell className="text-right">
                    {!s.current && (
                      <Button
                        size="sm"
                        variant="secondary-destructive"
                        onClick={async () => {
                          try {
                            await api.auth.revokeSession(s.id);
                            toast.success(t("account.revoked"));
                            sessions.reload();
                          } catch (e) {
                            toast.error(errMsg(e));
                          }
                        }}
                      >
                        {t("account.revoke")}
                      </Button>
                    )}
                  </Table.Cell>
                </Table.Row>
              ))}
            </Table.Body>
          </Table>
        </LayerCard>
      )}
    </Section>
  );
}

function CliSection() {
  const { t } = useI18n();
  const { info } = useSession();
  const origin = info.public_url || window.location.origin;
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <TerminalWindowIcon size={18} />
          {t("account.cli")}
        </span>
      }
      description={t("account.cliDesc")}
    >
      <CodeBlock
        lang="bash"
        code={`curl -fsSL ${origin}/install.sh | sh\nblift login --server ${origin}\nblift project ls\nblift upload <project> ./file.zip\nblift share create <project> file.zip --expires 7d`}
      />
    </Section>
  );
}

const KEY_EXPIRY = { "1d": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400, never: 0 } as const;
type KeyExpiry = keyof typeof KEY_EXPIRY;
/** How long each sign-in made with a key lasts, in days; 0 = until revoked. Keys are not numeric:
 * objects list integer-like keys first, which would reorder the select. */
const SESSION_TTL = { d7: 7, d30: 30, d90: 90, d365: 365, never: 0 } as const;
type SessionTtl = keyof typeof SESSION_TTL;

const keyState = (k: ApiKey): "active" | "expired" | "used" =>
  k.expires_at != null && k.expires_at < Date.now()
    ? "expired"
    : k.max_uses != null && k.use_count >= k.max_uses
      ? "used"
      : "active";

/** Keys that sign the CLI in without a browser (`blift login --api-key`, install.sh). */
/** "90 days" / "Until revoked" for a key's session_ttl (seconds). */
function useSessionTtlLabel() {
  const { t } = useI18n();
  return (seconds: number | null) =>
    seconds == null ? t("apikeys.untilRevoked") : t("apikeys.days", { n: Math.round(seconds / 86400) });
}

function ApiKeysSection() {
  const { t, lang } = useI18n();
  const ttlLabel = useSessionTtlLabel();
  const keys = useAsync(() => api.auth.apiKeys().then((r) => r.api_keys), []);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);

  return (
    <div id="api-keys">
      <Section
        title={
          <span className="flex items-center gap-2">
            <KeyIcon size={18} />
            {t("apikeys.title")}
          </span>
        }
        description={t("apikeys.desc")}
        actions={
          <Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>
            {t("apikeys.create")}
          </Button>
        }
        bodyClassName="p-0"
      >
        {keys.error != null && (
          <div className="p-5">
            <ErrorState error={keys.error} onRetry={keys.reload} />
          </div>
        )}
        {keys.loading && !keys.data ? (
          <Loading />
        ) : keys.data?.length === 0 ? (
          <Empty size="sm" icon={<KeyIcon size={32} />} title={t("apikeys.emptyTitle")} description={t("apikeys.emptyDesc")} />
        ) : (
          <LayerCard className="rounded-none p-0 ring-0">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("common.name")}</Table.Head>
                  <Table.Head>{t("apikeys.uses")}</Table.Head>
                  <Table.Head className="hidden sm:table-cell">{t("account.expires")}</Table.Head>
                  <Table.Head className="hidden lg:table-cell">{t("apikeys.sessionTtl")}</Table.Head>
                  <Table.Head className="hidden md:table-cell">{t("account.lastUsed")}</Table.Head>
                  <Table.Head className="hidden md:table-cell">{t("apikeys.sessions")}</Table.Head>
                  <Table.Head className="w-24" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {(keys.data ?? []).map((k) => {
                  const state = keyState(k);
                  return (
                    <Table.Row key={k.id}>
                      <Table.Cell>
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{k.name}</span>
                            {state !== "active" && (
                              <Badge variant="neutral">{t(state === "expired" ? "apikeys.expired" : "apikeys.usedUp")}</Badge>
                            )}
                          </div>
                          <span className="font-mono text-xs text-kumo-subtle">{k.prefix}…</span>
                        </div>
                      </Table.Cell>
                      <Table.Cell className="text-kumo-subtle tabular-nums">
                        {k.use_count} / {k.max_uses ?? "∞"}
                      </Table.Cell>
                      <Table.Cell className="hidden text-kumo-subtle sm:table-cell">
                        {k.expires_at ? formatDate(k.expires_at, lang) : t("common.never")}
                      </Table.Cell>
                      <Table.Cell className="hidden text-kumo-subtle lg:table-cell">{ttlLabel(k.session_ttl)}</Table.Cell>
                      <Table.Cell className="hidden text-kumo-subtle md:table-cell">
                        {k.last_used_at ? formatRelative(k.last_used_at, lang) : "—"}
                      </Table.Cell>
                      <Table.Cell className="hidden text-kumo-subtle tabular-nums md:table-cell">{k.session_count}</Table.Cell>
                      <Table.Cell className="text-right">
                        <Button size="sm" variant="secondary-destructive" onClick={() => setDeleting(k)}>
                          {t("common.delete")}
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table>
          </LayerCard>
        )}
      </Section>

      <CreateApiKeyDialog open={creating} onOpenChange={setCreating} onCreated={keys.reload} />
      <DeleteApiKeyDialog apiKey={deleting} onClose={() => setDeleting(null)} onDeleted={keys.reload} />
    </div>
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const { info } = useSession();
  const origin = info.public_url || window.location.origin;
  const [name, setName] = useState("");
  const [maxUses, setMaxUses] = useState("1");
  const [expiry, setExpiry] = useState<KeyExpiry>("7d");
  const [sessionTtl, setSessionTtl] = useState<SessionTtl>("d90");
  const [key, setKey] = useState<string | null>(null);
  const ttlLabel = useSessionTtlLabel();

  useEffect(() => {
    if (open) {
      setName("");
      setMaxUses("1");
      setExpiry("7d");
      setSessionTtl("d90");
      setKey(null);
    }
  }, [open]);

  if (key) {
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("apikeys.createdTitle")}
        footer={
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {t("common.done")}
          </Button>
        }
      >
        <Banner variant="alert" icon={<WarningIcon weight="fill" />} title={t("apikeys.copyNow")} size="sm" />
        <ClipboardText text={key} size="base" />
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("apikeys.install")}</span>
          <ClipboardText text={`curl -fsSL ${origin}/install.sh | BLIFT_API_KEY=${key} sh`} size="base" />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("apikeys.login")}</span>
          <ClipboardText text={`BLIFT_API_KEY=${key} blift login --server ${origin}`} size="base" />
        </div>
      </FormDialog>
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("apikeys.create")}
      submitLabel={t("common.create")}
      submitDisabled={!name.trim()}
      onSubmit={async () => {
        const created = await api.auth.createApiKey({
          name: name.trim(),
          max_uses: maxUses ? Number(maxUses) : null,
          expires_in: KEY_EXPIRY[expiry] || null,
          session_ttl: SESSION_TTL[sessionTtl] * 86400 || null,
        });
        setKey(created.key);
        onCreated();
      }}
    >
      <Input
        label={t("common.name")}
        description={t("apikeys.nameHint")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={100}
        autoComplete="off"
        autoFocus
      />
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Input
          label={t("apikeys.maxUses")}
          description={t("apikeys.maxUsesHint")}
          type="number"
          min={1}
          value={maxUses}
          onChange={(e) => setMaxUses(e.target.value)}
          placeholder="∞"
        />
        <Select
          label={t("apikeys.expiry")}
          hideLabel={false}
          className="w-full"
          value={expiry}
          onValueChange={(v) => setExpiry(v as KeyExpiry)}
          items={{
            "1d": t("share.expiry.1d"),
            "7d": t("share.expiry.7d"),
            "30d": t("share.expiry.30d"),
            "90d": t("share.expiry.90d"),
            never: t("share.expiry.never"),
          }}
        />
      </div>
      <Select
        label={t("apikeys.sessionTtl")}
        hideLabel={false}
        description={t("apikeys.sessionTtlHint")}
        className="w-full"
        value={sessionTtl}
        onValueChange={(v) => setSessionTtl(v as SessionTtl)}
        items={Object.fromEntries(Object.entries(SESSION_TTL).map(([k, d]) => [k, ttlLabel(d ? d * 86400 : null)]))}
      />
    </FormDialog>
  );
}

function DeleteApiKeyDialog({
  apiKey,
  onClose,
  onDeleted,
}: {
  apiKey: ApiKey | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [revoke, setRevoke] = useState(true);
  useEffect(() => {
    if (apiKey) setRevoke(true);
  }, [apiKey]);
  return (
    <FormDialog
      open={apiKey != null}
      onOpenChange={(o) => !o && onClose()}
      title={t("apikeys.deleteTitle", { name: apiKey?.name ?? "" })}
      description={t("apikeys.deleteDesc")}
      size="base"
      submitLabel={t("common.delete")}
      submitVariant="destructive"
      onSubmit={async () => {
        const sessions = revoke && (apiKey?.session_count ?? 0) > 0;
        await api.auth.deleteApiKey(apiKey!.id, sessions);
        toast.success(t("apikeys.deleted"));
        onClose();
        onDeleted();
      }}
    >
      {(apiKey?.session_count ?? 0) > 0 && (
        <Checkbox
          label={t("apikeys.revokeSessions", { n: apiKey!.session_count })}
          checked={revoke}
          onCheckedChange={(v) => setRevoke(v === true)}
        />
      )}
    </FormDialog>
  );
}
