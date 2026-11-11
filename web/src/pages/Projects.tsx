import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Badge, Banner, Button, Empty, Input, LayerCard, Meter, Select, Table } from "@cloudflare/kumo";
import { FolderSimpleIcon, PlusIcon, WarningIcon } from "@phosphor-icons/react";
import { api, type Project, type ProjectRole, type StorageSummary } from "@/api";
import { useI18n } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { useUser } from "@/lib/session";
import { displayName, formatBytes, formatRelative } from "@/lib/format";
import { toast } from "@/lib/toast";
import { ErrorState, Loading, Page } from "@/components/Page";
import { FormDialog } from "@/components/Dialogs";
import { SearchInput } from "@/components/SearchInput";

export function RoleBadge({ role }: { role: ProjectRole }) {
  const { t } = useI18n();
  const variant = role === "owner" ? "orange" : role === "editor" ? "blue" : "neutral";
  return <Badge variant={variant}>{t(`role.${role}`)}</Badge>;
}

export function QuotaMeter({ used, quota, label }: { used: number; quota: number; label: string }) {
  const { t } = useI18n();
  const unlimited = quota < 0;
  return (
    <Meter
      label={label}
      value={unlimited ? 0 : Math.min(100, (used / Math.max(quota, 1)) * 100)}
      customValue={t("projects.quotaValue", {
        used: formatBytes(used),
        quota: unlimited ? t("common.unlimited") : formatBytes(quota),
      })}
    />
  );
}

export function ProjectsPage() {
  const { t, lang } = useI18n();
  const user = useUser();
  const navigate = useNavigate();
  const projects = useAsync(() => api.projects.list().then((r) => r.projects), []);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = projects.data ?? [];
    return needle
      ? list.filter((p) => p.name.toLowerCase().includes(needle) || p.description.toLowerCase().includes(needle))
      : list;
  }, [projects.data, q]);

  return (
    <Page
      title={t("projects.title")}
      description={t("projects.subtitle")}
      actions={
        <Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>
          {t("projects.new")}
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-[1fr_320px]">
        <div className="flex items-center">
          <SearchInput value={q} onChange={setQ} placeholder={t("projects.searchPlaceholder")} />
        </div>
        <div className="rounded-lg bg-kumo-base px-4 py-3 ring ring-kumo-line">
          <QuotaMeter used={user.used_bytes} quota={user.quota_bytes} label={t("projects.quota")} />
        </div>
      </div>

      {projects.error != null && <ErrorState error={projects.error} onRetry={projects.reload} />}
      {projects.loading && !projects.data ? (
        <Loading />
      ) : projects.data && projects.data.length === 0 ? (
        <Empty
          icon={<FolderSimpleIcon size={48} weight="duotone" />}
          title={t("projects.emptyTitle")}
          description={t("projects.emptyDesc")}
          contents={
            <Button variant="primary" icon={PlusIcon} onClick={() => setCreating(true)}>
              {t("projects.new")}
            </Button>
          }
        />
      ) : (
        <LayerCard className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("common.name")}</Table.Head>
                  <Table.Head>{t("common.role")}</Table.Head>
                  <Table.Head className="text-right">{t("projects.files")}</Table.Head>
                  <Table.Head className="text-right">{t("common.size")}</Table.Head>
                  <Table.Head>{t("common.owner")}</Table.Head>
                  <Table.Head>{t("common.updated")}</Table.Head>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filtered.map((p) => (
                  <Table.Row
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/projects/${p.id}`)}
                  >
                    <Table.Cell>
                      <Link
                        to={`/projects/${p.id}`}
                        className="flex items-center gap-2.5 font-medium text-kumo-link no-underline hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <FolderSimpleIcon size={18} className="shrink-0 text-kumo-subtle" weight="duotone" />
                        {p.name}
                      </Link>
                      {p.description && (
                        <div className="mt-0.5 max-w-md truncate pl-7 text-xs text-kumo-subtle">{p.description}</div>
                      )}
                    </Table.Cell>
                    <Table.Cell>
                      <RoleBadge role={p.role} />
                    </Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{p.blob_count}</Table.Cell>
                    <Table.Cell className="text-right tabular-nums">{formatBytes(p.used_bytes)}</Table.Cell>
                    <Table.Cell>{p.owner.id === user.id ? t("common.you") : displayName(p.owner)}</Table.Cell>
                    <Table.Cell className="text-kumo-subtle">{formatRelative(p.updated_at, lang)}</Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </LayerCard>
      )}

      <CreateProjectDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(p) => {
          toast.success(t("projects.created", { name: p.name }));
          navigate(`/projects/${p.id}`);
        }}
      />
    </Page>
  );
}

/** "name · location (provider)", the location only when the admin set one. */
const storageLabel = (s: StorageSummary) => `${s.location ? `${s.name} · ${s.location}` : s.name} (${s.provider})`;

function CreateProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (p: Project) => void;
}) {
  const { t } = useI18n();
  const storages = useAsync(() => (open ? api.storages().then((r) => r.storages) : Promise.resolve([])), [open]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [storageId, setStorageId] = useState<string>("");
  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
  const list = storages.data ?? [];
  const selected = storageId || list.find((s) => s.is_default)?.id || list[0]?.id || "";

  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) {
          setName("");
          setDescription("");
          setStorageId("");
        }
      }}
      title={t("projects.new")}
      submitLabel={t("common.create")}
      submitDisabled={!valid || (!storages.loading && list.length === 0)}
      onSubmit={async () => {
        const p = await api.projects.create({
          name,
          description: description || undefined,
          storage_id: selected || undefined,
        });
        onOpenChange(false);
        onCreated(p);
      }}
    >
      {!storages.loading && list.length === 0 && (
        <Banner variant="alert" icon={<WarningIcon weight="fill" />} title={t("projects.noStorage")} />
      )}
      <Input
        label={t("common.name")}
        description={t("projects.nameHint")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="my-project"
        autoFocus
        required
        variant={name && !valid ? "error" : "default"}
      />
      <Input
        label={t("common.description")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        required={false}
      />
      {(storages.loading || list.length > 0) && (
        <Select
          label={t("projects.storage")}
          description={t("projects.storageHint")}
          className="w-full"
          loading={storages.loading}
          value={selected}
          onValueChange={(v) => setStorageId(v as string)}
          items={Object.fromEntries(list.map((s) => [s.id, storageLabel(s)]))}
        />
      )}
    </FormDialog>
  );
}
