import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Button,
  DropdownMenu,
  Empty,
  Input,
  LayerCard,
  Loader,
  Radio,
  Select,
  SensitiveInput,
  Switch,
  Table,
} from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  ClockIcon,
  DatabaseIcon,
  DotsThreeIcon,
  GlobeIcon,
  ListChecksIcon,
  LockSimpleIcon,
  PauseCircleIcon,
  PencilSimpleIcon,
  PlayCircleIcon,
  PlugsConnectedIcon,
  PlusIcon,
  StarIcon,
  StopCircleIcon,
  TrashIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import {
  api,
  type AdminStorage,
  type Scrub,
  type StorageInput,
  type StorageObjectsMode,
  type StorageProvider,
} from "@/api";
import { useI18n, type TKey } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { formatBytes, formatDate, formatNumber } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Detail, ErrorState, Loading, Page } from "@/components/Page";
import { ConfirmDialog, DeleteResourceDialog, FormDialog } from "@/components/Dialogs";
import { MfaBanner } from "@/components/MfaBanner";

const PROVIDERS: Record<StorageProvider, { label: string; endpoint: string; region: string; pathStyle: boolean }> = {
  r2: { label: "Cloudflare R2", endpoint: "https://<ACCOUNT_ID>.r2.cloudflarestorage.com", region: "auto", pathStyle: true },
  b2: { label: "Backblaze B2", endpoint: "https://s3.us-west-004.backblazeb2.com", region: "us-west-004", pathStyle: true },
  s3: { label: "AWS S3", endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1", pathStyle: false },
  rustfs: { label: "RustFS", endpoint: "http://localhost:9000", region: "us-east-1", pathStyle: true },
  minio: { label: "MinIO", endpoint: "http://localhost:9000", region: "us-east-1", pathStyle: true },
  other: { label: "S3 compatible", endpoint: "https://", region: "us-east-1", pathStyle: true },
};

const POLL_MS = 15_000;

/** Problems found by a scrub. */
const scrubProblems = (s: Scrub) => s.missing + s.size_mismatch + s.orphaned;

/**
 * A backend being deleted never has a running scrub (the server cancels it); show a stale
 * "running" one as canceled so nothing polls or spins for it.
 */
const normalize = (s: AdminStorage): AdminStorage =>
  s.status === "deleting" && s.scrub?.status === "running" ? { ...s, scrub: { ...s.scrub, status: "canceled" } } : s;

export function StoragesPage() {
  const { t, errMsg } = useI18n();
  const storages = useAsync(() => api.admin.storages().then((r) => r.storages.map(normalize)), []);
  const [editing, setEditing] = useState<AdminStorage | "new" | null>(null);
  const [deleting, setDeleting] = useState<AdminStorage | null>(null);
  const [disabling, setDisabling] = useState<AdminStorage | null>(null);
  const [scrubId, setScrubId] = useState<string | null>(null);

  // Poll while a scrub is running (GC moves it forward a few pages per run; deleting rows are normalized).
  const scrubbing = storages.data?.some((s) => s.scrub?.status === "running") ?? false;
  const { reload, loading, data } = storages;
  useEffect(() => {
    if (!scrubbing || loading) return;
    const id = setTimeout(reload, POLL_MS);
    return () => clearTimeout(id);
  }, [scrubbing, loading, data, reload]);

  /** Put a backend returned by the API into the list without a reload. */
  const replace = (next: AdminStorage) =>
    storages.setData((list) => list?.map((s) => (s.id === next.id ? normalize(next) : s)));

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const test = (s: AdminStorage) =>
    run(async () => {
      const r = await api.admin.testStorage({ id: s.id, ...toInput(s) });
      if (r.ok) toast.success(t("storages.testOk", { ms: r.latency_ms }));
      else toast.error(t("storages.testFail", { error: r.error ?? "" }));
    });

  const cors = async (s: AdminStorage) => {
    try {
      const r = await api.admin.applyCors(s.id, [window.location.origin]);
      if (r.ok) toast.success(t("storages.corsOk"));
      else toast.error(t("storages.corsFail", { error: r.error ?? "" }));
    } catch (e) {
      toast.error(t("storages.corsFail", { error: errMsg(e) }));
    }
  };

  const makeDefault = (s: AdminStorage) =>
    run(async () => {
      await api.admin.updateStorage(s.id, { is_default: true });
      toast.success(t("storages.saved"));
      storages.reload();
    });

  const setStatus = async (s: AdminStorage, status: "active" | "disabled") => {
    replace(await api.admin.updateStorage(s.id, { status }));
    toast.success(t(status === "disabled" ? "storages.disabledToast" : "storages.enabledToast", { name: s.name }));
  };

  const startScrub = (s: AdminStorage) =>
    run(async () => {
      const next = await api.admin.startScrub(s.id);
      replace(next);
      const scrub = next.scrub;
      if (!scrub || scrub.status === "running") toast.success(t("storages.scrubStarted"));
      else if (scrub.status === "failed") toast.error(t("storages.scrubFailed"), scrub.error ?? undefined);
      else if (scrub.status === "done") {
        const n = scrubProblems(scrub);
        if (n === 0) toast.success(t("storages.scrubFinished"));
        else toast.warning(t("storages.scrubFinished"), t("storages.scrubProblems", { n }));
      }
    });

  const cancelScrub = (s: AdminStorage) =>
    run(async () => {
      replace(await api.admin.cancelScrub(s.id));
      toast.success(t("storages.scrubCanceled"));
    });

  const addButton = (
    <Button variant="primary" icon={PlusIcon} onClick={() => setEditing("new")}>
      {t("storages.add")}
    </Button>
  );

  const scrubStorage = storages.data?.find((s) => s.id === scrubId) ?? null;
  // A backend that holds data (or one already being deleted) is deleted together with its projects.
  const withProjects = deleting != null && (deleting.in_use || deleting.status === "deleting");

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
                {(storages.data ?? []).map((s) => {
                  const isDeleting = s.status === "deleting";
                  const running = s.scrub?.status === "running";
                  return (
                    <Table.Row key={s.id}>
                      <Table.Cell>
                        <div className="flex flex-wrap items-center gap-2 font-medium">
                          {s.name}
                          {s.is_default && <Badge variant="blue">{t("common.default")}</Badge>}
                          {s.status === "disabled" && <Badge variant="orange">{t("storages.status.disabled")}</Badge>}
                          {isDeleting && <Badge variant="red">{t("storages.status.deleting")}</Badge>}
                          {s.scrub && (
                            <button
                              type="button"
                              className="cursor-pointer border-0 bg-transparent p-0"
                              title={t("storages.scrubView")}
                              onClick={() => setScrubId(s.id)}
                            >
                              <ScrubBadge scrub={s.scrub} />
                            </button>
                          )}
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
                            {!isDeleting && (
                              <>
                                <DropdownMenu.Item icon={PencilSimpleIcon} onClick={() => setEditing(s)}>
                                  {t("common.edit")}
                                </DropdownMenu.Item>
                                <DropdownMenu.Item icon={PlugsConnectedIcon} onClick={() => test(s)}>
                                  {t("storages.testConnection")}
                                </DropdownMenu.Item>
                                <DropdownMenu.Item icon={GlobeIcon} onClick={() => cors(s)}>
                                  {t("storages.applyCors")}
                                </DropdownMenu.Item>
                                {!s.is_default && s.status === "active" && (
                                  <DropdownMenu.Item icon={StarIcon} onClick={() => makeDefault(s)}>
                                    {t("storages.makeDefault")}
                                  </DropdownMenu.Item>
                                )}
                                <DropdownMenu.Separator />
                                {s.status === "active" ? (
                                  <DropdownMenu.Item
                                    icon={PauseCircleIcon}
                                    onClick={() => (s.project_count > 0 ? setDisabling(s) : run(() => setStatus(s, "disabled")))}
                                  >
                                    {t("storages.disable")}
                                  </DropdownMenu.Item>
                                ) : (
                                  <DropdownMenu.Item icon={PlayCircleIcon} onClick={() => run(() => setStatus(s, "active"))}>
                                    {t("storages.enable")}
                                  </DropdownMenu.Item>
                                )}
                                {running ? (
                                  <DropdownMenu.Item icon={StopCircleIcon} onClick={() => cancelScrub(s)}>
                                    {t("storages.scrubCancel")}
                                  </DropdownMenu.Item>
                                ) : (
                                  <DropdownMenu.Item icon={ListChecksIcon} onClick={() => startScrub(s)}>
                                    {t("storages.scrub")}
                                  </DropdownMenu.Item>
                                )}
                              </>
                            )}
                            {s.scrub && (
                              <DropdownMenu.Item icon={ListChecksIcon} onClick={() => setScrubId(s.id)}>
                                {t("storages.scrubView")}
                              </DropdownMenu.Item>
                            )}
                            {(!isDeleting || s.scrub) && <DropdownMenu.Separator />}
                            <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={() => setDeleting(s)}>
                              {t("common.delete")}
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
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
        open={deleting != null && !withProjects}
        onOpenChange={(o) => !o && setDeleting(null)}
        resourceName={deleting?.name ?? ""}
        resourceType={t("deleteResource.type.storage")}
        onDelete={async () => {
          await api.admin.deleteStorage(deleting!.id);
          toast.success(t("storages.deleted"));
          storages.reload();
        }}
      />
      <DeleteWithProjectsDialog
        storage={withProjects ? deleting : null}
        onClose={() => setDeleting(null)}
        onDeleted={(s) => {
          toast.success(t("storages.deletingToast", { name: s.name }));
          storages.reload();
        }}
      />
      <ConfirmDialog
        open={disabling != null}
        onOpenChange={(o) => !o && setDisabling(null)}
        title={t("storages.disableTitle", { name: disabling?.name ?? "" })}
        description={t("storages.disableDesc", { n: disabling?.project_count ?? 0 })}
        confirmLabel={t("storages.disable")}
        onConfirm={() => setStatus(disabling!, "disabled")}
      />
      <ScrubDialog storage={scrubStorage} onClose={() => setScrubId(null)} onStart={startScrub} onCancel={cancelScrub} />
    </Page>
  );
}

function ScrubBadge({ scrub }: { scrub: Scrub }) {
  const { t, lang } = useI18n();
  switch (scrub.status) {
    case "running":
      return (
        <Badge variant="blue" icon={<Loader size={10} />}>
          {t("storages.scrubRunning", { objects: formatNumber(scrub.objects, lang) })}
        </Badge>
      );
    case "failed":
      return <Badge variant="red">{t("storages.scrubFailed")}</Badge>;
    case "canceled":
      return <Badge variant="neutral">{t("storages.scrubCanceledBadge")}</Badge>;
    default: {
      const n = scrubProblems(scrub);
      return n === 0 ? (
        <Badge variant="green">{t("storages.scrubOk")}</Badge>
      ) : (
        <Badge variant="orange">{t("storages.scrubProblems", { n: formatNumber(n, lang) })}</Badge>
      );
    }
  }
}

const SCRUB_STATUS_VARIANT = { running: "blue", done: "green", canceled: "neutral", failed: "red" } as const;

/** The last scrub of a backend; `storage` comes from the (polled) list, so counters move while it runs. */
function ScrubDialog({
  storage,
  onClose,
  onStart,
  onCancel,
}: {
  storage: AdminStorage | null;
  onClose: () => void;
  onStart: (s: AdminStorage) => Promise<void>;
  onCancel: (s: AdminStorage) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const scrub = storage?.scrub;
  const [busy, setBusy] = useState(false);
  const act = async (fn: (s: AdminStorage) => Promise<void>) => {
    if (busy || !storage) return;
    setBusy(true);
    try {
      await fn(storage);
    } finally {
      setBusy(false);
    }
  };
  const num = (n: number) => formatNumber(n, lang);
  return (
    <FormDialog
      open={storage != null && scrub != null}
      onOpenChange={(o) => !o && onClose()}
      title={t("storages.scrubTitle", { name: storage?.name ?? "" })}
      description={t("storages.scrubDesc")}
      size="xl"
      footer={
        storage &&
        scrub && (
          <>
            {scrub.status === "running" ? (
              <Button type="button" variant="secondary" icon={StopCircleIcon}
                className="mr-auto"
                loading={busy}
                onClick={() => act(onCancel)}
              >
                {t("storages.scrubCancel")}
              </Button>
            ) : (
              storage.status !== "deleting" && (
                <Button type="button" variant="secondary" icon={ArrowClockwiseIcon}
                  className="mr-auto"
                  loading={busy}
                  onClick={() => act(onStart)}
                >
                  {t("storages.scrubRestart")}
                </Button>
              )
            )}
            <Button type="button" variant="primary" onClick={onClose}>
              {t("common.close")}
            </Button>
          </>
        )
      }
    >
      {scrub && (
        <>
          {scrub.status === "running" && (
            <Banner variant="default" size="sm" icon={<ClockIcon weight="fill" />} title={t("storages.scrubBackground")} />
          )}
          {scrub.status === "failed" && scrub.error && (
            <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={t("storages.scrubFailed")} description={scrub.error} />
          )}
          <div className="flex flex-col gap-3">
            <Detail label={t("common.status")}>
              <Badge variant={SCRUB_STATUS_VARIANT[scrub.status]} icon={scrub.status === "running" ? <Loader size={10} /> : undefined}>
                {t(`storages.scrubStatus.${scrub.status}` as TKey)}
              </Badge>
            </Detail>
            <Detail label={t("storages.scrubStartedAt")}>{formatDate(scrub.started_at, lang)}</Detail>
            {scrub.finished_at != null && <Detail label={t("storages.scrubFinishedAt")}>{formatDate(scrub.finished_at, lang)}</Detail>}
            <Detail label={t("storages.scrubObjects")}>
              {num(scrub.objects)} · {formatBytes(scrub.object_bytes)}
            </Detail>
            <Detail label={t("storages.scrubFiles")}>{num(scrub.files)}</Detail>
            <Detail label={t("storages.scrubMissing")}>
              <Count n={scrub.missing} />
            </Detail>
            <Detail label={t("storages.scrubMismatch")}>
              <Count n={scrub.size_mismatch} />
            </Detail>
            <Detail label={t("storages.scrubOrphaned")}>
              <Count n={scrub.orphaned} />
              {scrub.orphaned > 0 && <span className="text-kumo-subtle"> · {formatBytes(scrub.orphaned_bytes)}</span>}
            </Detail>
          </div>
          {scrub.issues.length === 0 ? (
            scrub.status === "done" && <p className="m-0 text-sm text-kumo-subtle">{t("storages.scrubNoIssues")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                {scrubProblems(scrub) > scrub.issues.length
                  ? t("storages.scrubIssuesFirst", { n: scrub.issues.length })
                  : t("storages.scrubIssues")}
              </span>
              <div className="max-h-80 overflow-auto rounded-md ring ring-kumo-line">
                <Table>
                  <Table.Header>
                    <Table.Row>
                      <Table.Head>{t("storages.scrubKind")}</Table.Head>
                      <Table.Head>{t("storages.scrubKey")}</Table.Head>
                      <Table.Head className="text-right">{t("storages.scrubSize")}</Table.Head>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {scrub.issues.map((issue, n) => (
                      <Table.Row key={n}>
                        <Table.Cell>
                          <Badge variant={issue.kind === "orphaned" ? "neutral" : "orange"}>
                            {t(`storages.scrubKind.${issue.kind}` as TKey)}
                          </Badge>
                        </Table.Cell>
                        <Table.Cell className="max-w-[24rem] font-mono text-xs break-all">{issue.key}</Table.Cell>
                        <Table.Cell className="text-right text-xs whitespace-nowrap tabular-nums">
                          {issue.size != null ? formatBytes(issue.size) : "–"} /{" "}
                          {issue.object_size != null ? formatBytes(issue.object_size) : "–"}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table>
              </div>
            </div>
          )}
        </>
      )}
    </FormDialog>
  );
}

function Count({ n }: { n: number }) {
  const { lang } = useI18n();
  return <span className={n > 0 ? "font-medium text-kumo-danger" : undefined}>{formatNumber(n, lang)}</span>;
}

/** Deleting a backend that holds projects: all of them go, and the admin picks what happens to the objects. */
function DeleteWithProjectsDialog({
  storage,
  onClose,
  onDeleted,
}: {
  storage: AdminStorage | null;
  onClose: () => void;
  onDeleted: (s: AdminStorage) => void;
}) {
  const { t } = useI18n();
  const [objects, setObjects] = useState<StorageObjectsMode>("delete");
  const [confirm, setConfirm] = useState("");
  // A backend already being deleted can be submitted again to switch what happens to the objects.
  const resubmit = storage?.status === "deleting";

  useEffect(() => {
    if (!storage) return;
    setConfirm("");
    setObjects(storage.status === "deleting" ? storage.objects : "delete");
  }, [storage]);

  const name = storage?.name ?? "";
  return (
    <FormDialog
      open={storage != null}
      onOpenChange={(o) => !o && onClose()}
      title={
        storage && storage.project_count === 0 && storage.status !== "deleting"
          ? t("deleteResource.title", { name })
          : t("storages.deleteWithProjectsTitle", { name })
      }
      size="lg"
      submitLabel={t("deleteResource.button", { type: t("deleteResource.type.storage") })}
      submitVariant="destructive"
      submitDisabled={!resubmit && confirm !== name}
      onSubmit={async () => {
        const s = storage!;
        await api.admin.deleteStorage(s.id, { projects: true, objects });
        onClose();
        onDeleted(s);
      }}
    >
      {storage &&
        (resubmit ? (
          <Banner
            variant="alert"
            icon={<WarningCircleIcon weight="fill" />}
            title={t("storages.deletingBanner", { mode: t(`storages.deleteObjects.${storage.objects}` as TKey) })}
          />
        ) : (
          <Banner
            variant="error"
            icon={<WarningCircleIcon weight="fill" />}
            title={
              storage.project_count > 0
                ? t("storages.deleteWithProjectsBody", { n: storage.project_count, size: formatBytes(storage.used_bytes) })
                : t("storages.deleteLeftoversBody")
            }
          />
        ))}
      <Radio.Group
        legend={t("storages.deleteObjects")}
        appearance="card"
        value={objects}
        onValueChange={(v) => setObjects(v as StorageObjectsMode)}
      >
        <Radio.Item value="delete" label={t("storages.deleteObjects.delete")} description={t("storages.deleteObjects.deleteDesc")} />
        <Radio.Item value="keep" label={t("storages.deleteObjects.keep")} description={t("storages.deleteObjects.keepDesc")} />
      </Radio.Group>
      {!resubmit && (
        <div className="flex flex-col gap-2">
          <span className="text-sm">
            {t("deleteResource.typeToConfirm")}
            <code className="ml-1 rounded-md bg-kumo-tint px-2 py-1 font-mono text-sm font-semibold">{name}</code>
          </span>
          <Input
            aria-label={name}
            placeholder={name}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="w-full"
          />
        </div>
      )}
    </FormDialog>
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
  const saved = storage === "new" ? null : storage;
  // A backend that holds data can only be moved while disabled, and its prefix never changes
  const holdsData = saved != null && saved.in_use;
  const moveLocked = holdsData && saved.status === "active";
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
    setForm((f) =>
      moveLocked
        ? { ...f, provider: p }
        : {
            ...f,
            provider: p,
            region: !f.region || f.region === prev.region ? next.region : f.region,
            path_style: next.pathStyle,
          },
    );
  };

  const payload = (): StorageInput => {
    const body: Partial<StorageInput> = { ...form };
    if (!body.secret_access_key) delete body.secret_access_key;
    return body as StorageInput;
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
        else {
          // Leave out the fields that cannot change so the PATCH only carries what may.
          const body: Partial<StorageInput> = payload();
          if (moveLocked) {
            delete body.endpoint;
            delete body.region;
            delete body.bucket;
            delete body.path_style;
          }
          if (holdsData) delete body.prefix;
          await api.admin.updateStorage(saved!.id, body);
        }
        onClose();
        onSaved();
      }}
    >
      {moveLocked && (
        <Banner variant="default" size="sm" icon={<LockSimpleIcon weight="fill" />} title={t("storages.lockedMove")} />
      )}
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
        disabled={moveLocked}
        required
      />
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <Input
          label={t("storages.bucket")}
          value={form.bucket}
          onChange={(e) => set("bucket", e.target.value)}
          disabled={moveLocked}
          required
        />
        <Input
          label={t("storages.region")}
          value={form.region}
          onChange={(e) => set("region", e.target.value)}
          placeholder={preset.region}
          disabled={moveLocked}
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
        description={holdsData ? t("storages.lockedPrefix") : t("storages.prefixHint")}
        disabled={holdsData}
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
          disabled={moveLocked}
          onCheckedChange={(v) => set("path_style", v)}
        />
        <p className="m-0 -mt-2 pl-12 text-xs text-kumo-subtle">{t("storages.pathStyleHint")}</p>
        <Switch label={t("storages.isDefault")} checked={form.is_default} onCheckedChange={(v) => set("is_default", v)} />
      </div>
    </FormDialog>
  );
}
