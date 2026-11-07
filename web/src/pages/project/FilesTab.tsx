import { useEffect, useRef, useState, type DragEvent } from "react";
import { Banner, Button, DropdownMenu, Empty, Input, LayerCard, Table, cn } from "@cloudflare/kumo";
import {
  CaretDownIcon,
  CaretUpIcon,
  CloudArrowUpIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  EyeIcon,
  LinkIcon,
  PencilSimpleIcon,
  ShareNetworkIcon,
  TrashIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { api, type Blob, type Project } from "@/api";
import { useI18n } from "@/i18n";
import { useAsync, useDebounced } from "@/lib/hooks";
import { displayName, formatBytes, formatDate, formatRelative } from "@/lib/format";
import { uploads } from "@/lib/upload";
import { copyText, toast } from "@/lib/toast";
import { ErrorState, Loading } from "@/components/Page";
import { ConfirmDialog, FormDialog } from "@/components/Dialogs";
import { ShareDialog } from "@/components/ShareDialog";
import { SearchInput } from "@/components/SearchInput";
import { FileIcon } from "@/components/FileIcon";
import { Pager } from "@/components/Pager";

type SortKey = "name" | "size" | "created_at";
const PER_PAGE = 50;

export function FilesTab({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const { t, lang, errMsg } = useI18n();
  const canEdit = project.role !== "viewer";
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [sort, setSort] = useState<SortKey>("created_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<Blob | null>(null);
  const [sharing, setSharing] = useState<Blob | null>(null);
  const [deleting, setDeleting] = useState<Blob[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  const list = useAsync(
    () => api.blobs.list(project.id, { q: dq || undefined, sort, order, limit: PER_PAGE, offset: (page - 1) * PER_PAGE }),
    [project.id, dq, sort, order, page],
  );
  const blobs = list.data?.blobs ?? [];

  useEffect(() => setPage(1), [dq, sort, order]);
  useEffect(() => setSelected(new Set()), [list.data]);
  useEffect(
    () =>
      uploads.onDone((pid) => {
        if (pid !== project.id) return;
        list.reload();
        onChanged();
      }),
    [project.id, list.reload, onChanged],
  );

  const startUpload = (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    uploads.add(project.id, project.name, Array.from(files));
  };

  const onDragEnter = (e: DragEvent) => {
    if (!canEdit || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = () => {
    if (!dragging) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!canEdit) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    startUpload(Array.from(e.dataTransfer.files).filter((f) => f.size > 0 || f.type !== ""));
  };

  const toggleSort = (key: SortKey) => {
    if (sort === key) setOrder((o) => (o === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setOrder(key === "name" ? "asc" : "desc");
    }
  };

  const copyLink = async (b: Blob) => {
    try {
      const { url } = await api.blobs.downloadUrl(b.id);
      await copyText(url);
      toast.success(t("project.linkCopied"));
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const allChecked = blobs.length > 0 && selected.size === blobs.length;

  return (
    <div
      className="relative flex flex-col gap-4"
      onDragEnter={onDragEnter}
      onDragOver={(e) => canEdit && e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder={t("project.searchFiles")} />
        <div className="flex-1" />
        {selected.size > 0 && canEdit && (
          <Button
            variant="secondary-destructive"
            icon={TrashIcon}
            onClick={() => setDeleting(blobs.filter((b) => selected.has(b.id)))}
          >
            {t("project.deleteSelected")} ({selected.size})
          </Button>
        )}
        {canEdit && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                startUpload(e.target.files);
                e.target.value = "";
              }}
            />
            <Button variant="primary" icon={UploadSimpleIcon} onClick={() => fileInput.current?.click()}>
              {t("project.upload")}
            </Button>
          </>
        )}
      </div>

      {!canEdit && <Banner variant="secondary" title={t("project.readonly")} size="sm" />}
      {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}

      {list.loading && !list.data ? (
        <Loading />
      ) : blobs.length === 0 && !dq ? (
        <Empty
          icon={<CloudArrowUpIcon size={48} weight="duotone" />}
          title={t("project.emptyTitle")}
          description={canEdit ? t("project.emptyDesc") : undefined}
          commandLine={canEdit ? t("project.emptyCli", { name: project.name }) : undefined}
          contents={
            canEdit && (
              <Button variant="primary" icon={UploadSimpleIcon} onClick={() => fileInput.current?.click()}>
                {t("project.upload")}
              </Button>
            )
          }
        />
      ) : (
        <LayerCard className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  {canEdit && (
                    <Table.CheckHead
                      checked={allChecked}
                      indeterminate={selected.size > 0 && !allChecked}
                      onCheckedChange={() => setSelected(allChecked ? new Set() : new Set(blobs.map((b) => b.id)))}
                      aria-label="select all"
                    />
                  )}
                  <SortHead label={t("common.name")} k="name" sort={sort} order={order} onClick={toggleSort} />
                  <SortHead
                    label={t("common.size")}
                    k="size"
                    sort={sort}
                    order={order}
                    onClick={toggleSort}
                    className="text-right"
                  />
                  <Table.Head className="hidden lg:table-cell">{t("project.uploadedBy")}</Table.Head>
                  <SortHead label={t("common.created")} k="created_at" sort={sort} order={order} onClick={toggleSort} />
                  <Table.Head className="hidden text-right md:table-cell">{t("project.downloads")}</Table.Head>
                  <Table.Head className="w-12" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {blobs.map((b) => (
                  <Table.Row key={b.id} variant={selected.has(b.id) ? "selected" : "default"}>
                    {canEdit && (
                      <Table.CheckCell
                        checked={selected.has(b.id)}
                        onCheckedChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(b.id)) n.delete(b.id);
                            else n.add(b.id);
                            return n;
                          })
                        }
                        aria-label={b.name}
                      />
                    )}
                    <Table.Cell className="max-w-[28rem]">
                      <a
                        href={api.blobs.downloadHref(b.id, true)}
                        target="_blank"
                        rel="noreferrer"
                        className="flex min-w-0 items-center gap-2.5 font-medium text-kumo-default no-underline hover:text-kumo-link hover:underline"
                        title={b.name}
                      >
                        <FileIcon name={b.name} type={b.content_type} />
                        <span className="truncate">{b.name}</span>
                      </a>
                    </Table.Cell>
                    <Table.Cell className="text-right whitespace-nowrap tabular-nums">{formatBytes(b.size)}</Table.Cell>
                    <Table.Cell className="hidden text-kumo-subtle lg:table-cell">{displayName(b.uploader)}</Table.Cell>
                    <Table.Cell className="whitespace-nowrap text-kumo-subtle" title={formatDate(b.created_at, lang)}>
                      {formatRelative(b.created_at, lang)}
                    </Table.Cell>
                    <Table.Cell className="hidden text-right tabular-nums md:table-cell">{b.download_count}</Table.Cell>
                    <Table.Cell className="text-right">
                      <BlobMenu
                        blob={b}
                        canEdit={canEdit}
                        onCopyLink={() => copyLink(b)}
                        onRename={() => setRenaming(b)}
                        onShare={() => setSharing(b)}
                        onDelete={() => setDeleting([b])}
                      />
                    </Table.Cell>
                  </Table.Row>
                ))}
                {blobs.length === 0 && (
                  <Table.Row>
                    <Table.Cell colSpan={7} className="py-10 text-center text-kumo-subtle">
                      {t("err.not_found")}
                    </Table.Cell>
                  </Table.Row>
                )}
              </Table.Body>
            </Table>
          </div>
        </LayerCard>
      )}

      <Pager page={page} setPage={setPage} perPage={PER_PAGE} total={list.data?.total ?? 0} />

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-kumo-brand bg-kumo-base/85">
          <div className="flex flex-col items-center gap-2 text-kumo-default">
            <CloudArrowUpIcon size={40} weight="duotone" className="text-kumo-brand" />
            <span className="font-medium">{t("project.dropHere", { name: project.name })}</span>
          </div>
        </div>
      )}

      <RenameDialog
        blob={renaming}
        onClose={() => setRenaming(null)}
        onRenamed={() => {
          toast.success(t("project.renamed"));
          list.reload();
        }}
      />
      <ShareDialog
        open={sharing != null}
        onOpenChange={(o) => !o && setSharing(null)}
        project={project}
        blob={sharing}
      />
      <ConfirmDialog
        open={deleting != null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={
          deleting?.length === 1
            ? t("project.deleteFileTitle", { name: deleting[0].name })
            : t("project.deleteFilesTitle", { n: deleting?.length ?? 0 })
        }
        description={t("project.deleteFilesDesc")}
        onConfirm={async () => {
          const ids = deleting!.map((b) => b.id);
          if (ids.length === 1) await api.blobs.remove(ids[0]);
          else await api.blobs.bulkDelete(project.id, ids);
          toast.success(t("project.deleted", { n: ids.length }));
          list.reload();
          onChanged();
        }}
      />
    </div>
  );
}

function SortHead({
  label,
  k,
  sort,
  order,
  onClick,
  className,
}: {
  label: string;
  k: SortKey;
  sort: SortKey;
  order: "asc" | "desc";
  onClick: (k: SortKey) => void;
  className?: string;
}) {
  const active = sort === k;
  const Icon = order === "asc" ? CaretUpIcon : CaretDownIcon;
  return (
    <Table.Head className={className}>
      <button
        type="button"
        onClick={() => onClick(k)}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1 bg-transparent p-0 font-[inherit] text-[inherit]",
          active ? "text-kumo-default" : "",
        )}
      >
        {label}
        <Icon size={12} className={active ? "opacity-100" : "opacity-0"} />
      </button>
    </Table.Head>
  );
}

function BlobMenu({
  blob,
  canEdit,
  onCopyLink,
  onRename,
  onShare,
  onDelete,
}: {
  blob: Blob;
  canEdit: boolean;
  onCopyLink: () => void;
  onRename: () => void;
  onShare: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={<Button variant="ghost" size="sm" shape="square" icon={DotsThreeIcon} aria-label={t("common.actions")} />}
      />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item
          icon={DownloadSimpleIcon}
          onClick={() => {
            window.location.href = api.blobs.downloadHref(blob.id);
          }}
        >
          {t("common.download")}
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={EyeIcon} onClick={() => window.open(api.blobs.downloadHref(blob.id, true), "_blank")}>
          {t("common.preview")}
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={LinkIcon} onClick={onCopyLink}>
          {t("common.copyLink")}
        </DropdownMenu.Item>
        {canEdit && (
          <>
            <DropdownMenu.Item icon={ShareNetworkIcon} onClick={onShare}>
              {t("common.share")}
            </DropdownMenu.Item>
            <DropdownMenu.Item icon={PencilSimpleIcon} onClick={onRename}>
              {t("common.rename")}
            </DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={onDelete}>
              {t("common.delete")}
            </DropdownMenu.Item>
          </>
        )}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

function RenameDialog({
  blob,
  onClose,
  onRenamed,
}: {
  blob: Blob | null;
  onClose: () => void;
  onRenamed: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  useEffect(() => {
    if (blob) setName(blob.name);
  }, [blob]);
  const valid = name.length > 0 && name.length <= 255 && !/[/\\]/.test(name) && name !== "." && name !== "..";
  return (
    <FormDialog
      open={blob != null}
      onOpenChange={(o) => !o && onClose()}
      title={t("project.renameTitle")}
      submitLabel={t("common.rename")}
      submitDisabled={!valid || name === blob?.name}
      onSubmit={async () => {
        await api.blobs.rename(blob!.id, name);
        onClose();
        onRenamed();
      }}
    >
      <Input
        label={t("common.name")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
        onFocus={(e) => {
          const dot = e.target.value.lastIndexOf(".");
          e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length);
        }}
      />
    </FormDialog>
  );
}

