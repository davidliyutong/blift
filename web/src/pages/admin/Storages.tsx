import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  DropdownMenu,
  Empty,
  Input,
  LayerCard,
  Select,
  SensitiveInput,
  Switch,
  Table,
} from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  DatabaseIcon,
  DotsThreeIcon,
  GlobeIcon,
  PencilSimpleIcon,
  PlugsConnectedIcon,
  PlusIcon,
  StarIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { api, type AdminStorage, type StorageInput, type StorageProvider } from "@/api";
import { useI18n, type TKey } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { formatBytes } from "@/lib/format";
import { toast } from "@/lib/toast";
import { ErrorState, Loading, Page } from "@/components/Page";
import { DeleteResourceDialog, FormDialog } from "@/components/Dialogs";
import { MfaBanner } from "@/components/MfaBanner";

const PROVIDERS: Record<StorageProvider, { label: string; endpoint: string; region: string; pathStyle: boolean }> = {
  r2: { label: "Cloudflare R2", endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com", region: "auto", pathStyle: true },
  b2: { label: "Backblaze B2", endpoint: "https://s3.us-west-004.backblazeb2.com", region: "us-west-004", pathStyle: true },
  s3: { label: "AWS S3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", pathStyle: false },
  rustfs: { label: "RustFS", endpoint: "http://localhost:9000", region: "us-east-1", pathStyle: true },
  minio: { label: "MinIO", endpoint: "http://localhost:9000", region: "us-east-1", pathStyle: true },
  other: { label: "S3 compatible", endpoint: "https://", region: "us-east-1", pathStyle: true },
};

export function StoragesPage() {
  const { t, errMsg } = useI18n();
  const storages = useAsync(() => api.admin.storages().then((r) => r.storages), []);
  const [editing, setEditing] = useState<AdminStorage | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdminStorage | null>(null);

  const test = async (s: AdminStorage) => {
    try {
      const r = await api.admin.testStorage({ id: s.id, ...toInput(s) });
      if (r.ok) toast.success(t("storages.testOk", { ms: r.latency_ms }));
      else toast.error(t("storages.testFail", { error: r.error ?? "" }));
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const cors = async (s: AdminStorage) => {
    try {
      const r = await api.admin.applyCors(s.id, [window.location.origin]);
      if (r.ok) toast.success(t("storages.corsOk"));
      else toast.error(t("storages.corsFail", { error: r.error ?? "" }));
    } catch (e) {
      toast.error(t("storages.corsFail", { error: errMsg(e) }));
    }
  };

  const makeDefault = async (s: AdminStorage) => {
    try {
      await api.admin.updateStorage(s.id, { is_default: true });
      toast.success(t("storages.saved"));
      storages.reload();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const addButton = (
    <Button variant="primary" icon={PlusIcon} onClick={() => setEditing("new")}>
      {t("storages.add")}
    </Button>
  );

  return (
    <Page title={t("storages.title")} description={t("storages.subtitle")} actions={addButton}>
      <MfaBanner />
      {storages.error != null && <ErrorState error={storages.error} onRetry={storages.reload} />}
      {storages.loading && !storages.data ? (
        <Loading />
      ) : storages.data?.length === 0 ? (
        <Empty
          icon={<DatabaseIcon size={48} weight="duotone" />}
          title={t("storages.emptyTitle")}
          description={t("storages.emptyDesc")}
          contents={addButton}
        />
      ) : (
        <LayerCard className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("common.name")}</Table.Head>
                  <Table.Head>{t("storages.provider")}</Table.Head>
                  <Table.Head className="hidden sm:table-cell">{t("storages.location")}</Table.Head>
                  <Table.Head className="hidden md:table-cell">{t("storages.bucket")}</Table.Head>
                  <Table.Head className="text-right">{t("storages.projects")}</Table.Head>
                  <Table.Head className="text-right">{t("storages.used")}</Table.Head>
                  <Table.Head className="w-12" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {(storages.data ?? []).map((s) => (
                  <Table.Row key={s.id}>
                    <Table.Cell>
                      <div className="flex items-center gap-2 font-medium">
                        {s.name}
                        {s.is_default && <Badge variant="blue">{t("common.default")}</Badge>}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge variant="outline">{PROVIDERS[s.provider]?.label ?? s.provider}</Badge>
                    </Table.Cell>
                    <Table.Cell className="hidden sm:table-cell">{s.location}</Table.Cell>
                    <Table.Cell className="hidden max-w-[22rem] md:table-cell">
                      <div className="truncate font-mono text-xs">
                        {s.bucket}
                        {s.prefix && <span className="text-kumo-subtle">/{s.prefix.replace(/^\//, "")}</span>}
                      </div>
                      <div className="truncate font-mono text-xs text-kumo-subtle">{s.endpoint}</div>
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{s.project_count}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{formatBytes(s.used_bytes)}</Table.Cell>
                    <Table.Cell className="text-right">
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          render={
                            <Button variant="ghost" size="sm" shape="square" icon={DotsThreeIcon} aria-label={t("common.actions")} />
                          }
                        />
                        <DropdownMenu.Content align="end">
                          <DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => setEditing(s)}>
                            {t("common.edit")}
                          </DropdownMenu.Item>
                          <DropdownMenu.Item icon={PlugsConnectedIcon} onClick={() => test(s)}>
                            {t("storages.testConnection")}
                          </DropdownMenu.Item>
                          <DropdownMenu.Item icon={GlobeIcon} onClick={() => cors(s)}>
                            {t("storages.applyCors")}
                          </DropdownMenu.Item>
                          {!s.is_default && (
                            <DropdownMenu.Item icon={StarIcon} onClick={() => makeDefault(s)}>
                              {t("storages.makeDefault")}
                            </DropdownMenu.Item>
                          )}
                          <DropdownMenu.Separator />
                          <DropdownMenu.Item
                            icon={TrashIcon}
                            variant="danger"
                            disabled={s.project_count > 0}
                            onClick={() => setDeleting(s)}
                          >
                            {t("common.delete")}
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </LayerCard>
      )}

      <StorageDialog
        storage={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          toast.success(t("storages.saved"));
          storages.reload();
        }}
      />
      <DeleteResourceDialog
        open={deleting != null}
        onOpenChange={(o) => !o && setDeleting(null)}
        resourceName={deleting?.name ?? ""}
        resourceType={t("deleteResource.type.storage")}
        onDelete={async () => {
          await api.admin.deleteStorage(deleting!.id);
          toast.success(t("storages.deleted"));
          storages.reload();
        }}
      />
    </Page>
  );
}

function toInput(s: AdminStorage): StorageInput {
  return {
    name: s.name,
    provider: s.provider,
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    access_key_id: s.access_key_id,
    path_style: s.path_style,
    prefix: s.prefix,
    location: s.location,
    is_default: s.is_default,
  };
}

const EMPTY: StorageInput = {
  name: "",
  provider: "r2",
  endpoint: "",
  region: "auto",
  bucket: "",
  access_key_id: "",
  secret_access_key: "",
  path_style: true,
  prefix: "",
  location: "",
  is_default: false,
};

function StorageDialog({
  storage,
  onClose,
  onSaved,
}: {
  storage: AdminStorage | "new" | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, errMsg } = useI18n();
  const isNew = storage === "new";
  const [form, setForm] = useState<StorageInput>(EMPTY);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!storage) return;
    setTestResult(null);
    setForm(storage === "new" ? EMPTY : { ...toInput(storage), secret_access_key: "" });
  }, [storage]);

  const set = <K extends keyof StorageInput>(k: K, v: StorageInput[K]) => setForm((f) => ({ ...f, [k]: v }));

  const changeProvider = (p: StorageProvider) => {
    const prev = PROVIDERS[form.provider];
    const next = PROVIDERS[p];
    setForm((f) => ({
      ...f,
      provider: p,
      region: !f.region || f.region === prev.region ? next.region : f.region,
      path_style: next.pathStyle,
    }));
  };

  const payload = (): StorageInput => {
    const body = { ...form };
    if (!body.secret_access_key) delete body.secret_access_key;
    return body;
  };

  const runTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await api.admin.testStorage({ ...payload(), id: isNew ? undefined : (storage as AdminStorage).id });
      setTestResult(
        r.ok
          ? { ok: true, text: t("storages.testOk", { ms: r.latency_ms }) }
          : { ok: false, text: t("storages.testFail", { error: r.error ?? "" }) },
      );
    } catch (e) {
      setTestResult({ ok: false, text: errMsg(e) });
    } finally {
      setTesting(false);
    }
  };

  const required = form.name && form.endpoint && form.region && form.bucket && form.access_key_id;
  const preset = PROVIDERS[form.provider];

  return (
    <FormDialog
      open={storage != null}
      onOpenChange={(o) => !o && onClose()}
      title={isNew ? t("storages.addTitle") : t("storages.editTitle")}
      size="xl"
      submitDisabled={!required || (isNew && !form.secret_access_key)}
      extraActions={
        <Button type="button" variant="secondary" icon={PlugsConnectedIcon} loading={testing} onClick={runTest}>
          {t("storages.testConnection")}
        </Button>
      }
      onSubmit={async () => {
        if (isNew) await api.admin.createStorage(payload());
        else await api.admin.updateStorage((storage as AdminStorage).id, payload());
        onClose();
        onSaved();
      }}
    >
      {testResult && (
        <Banner
          variant={testResult.ok ? "default" : "error"}
          icon={testResult.ok ? <CheckCircleIcon weight="fill" /> : <WarningCircleIcon weight="fill" />}
          title={testResult.text}
        />
      )}
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Input label={t("common.name")} value={form.name} onChange={(e) => set("name", e.target.value)} required autoFocus />
        <Select
          label={t("storages.provider")}
          hideLabel={false}
          className="w-full"
          value={form.provider}
          onValueChange={(v) => changeProvider(v as StorageProvider)}
          items={Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, v.label]))}
        />
      </div>
      <p className="m-0 -mt-1 rounded-md bg-kumo-recessed px-3 py-2 font-mono text-xs text-kumo-subtle">
        {t(`storages.hint.${form.provider}` as TKey)}
      </p>
      <Input
        label={t("storages.endpoint")}
        value={form.endpoint}
        onChange={(e) => set("endpoint", e.target.value)}
        placeholder={preset.endpoint}
        className="font-mono"
        required
      />
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Input label={t("storages.bucket")} value={form.bucket} onChange={(e) => set("bucket", e.target.value)} required />
        <Input
          label={t("storages.region")}
          value={form.region}
          onChange={(e) => set("region", e.target.value)}
          placeholder={preset.region}
          required
        />
        <Input
          label={t("storages.accessKey")}
          value={form.access_key_id}
          onChange={(e) => set("access_key_id", e.target.value)}
          autoComplete="off"
          className="font-mono"
          required
        />
        <SensitiveInput
          label={t("storages.secretKey")}
          description={isNew ? undefined : t("storages.secretKeep")}
          value={form.secret_access_key ?? ""}
          onValueChange={(v) => set("secret_access_key", v)}
          autoComplete="off"
          required={isNew}
        />
      </div>
      <Input
        label={t("storages.prefix")}
        description={t("storages.prefixHint")}
        value={form.prefix}
        onChange={(e) => set("prefix", e.target.value)}
        placeholder="blift/"
        className="font-mono"
        required={false}
      />
      <Input
        label={t("storages.location")}
        description={t("storages.locationHint")}
        value={form.location}
        onChange={(e) => set("location", e.target.value)}
        maxLength={64}
        required={false}
      />
      <div className="flex flex-col gap-3">
        <Switch
          label={t("storages.pathStyle")}
          checked={form.path_style}
          onCheckedChange={(v) => set("path_style", v)}
        />
        <p className="m-0 -mt-2 pl-12 text-xs text-kumo-subtle">{t("storages.pathStyleHint")}</p>
        <Switch label={t("storages.isDefault")} checked={form.is_default} onCheckedChange={(v) => set("is_default", v)} />
      </div>
    </FormDialog>
  );
}
