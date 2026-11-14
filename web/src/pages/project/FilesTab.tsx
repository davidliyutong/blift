import { Fragment, useEffect, useRef, useState, type DragEvent } from "react";
import { Link, useSearchParams } from "react-router";
import { Banner, Button, DropdownMenu, Empty, Input, LayerCard, Loader, Table, cn } from "@cloudflare/kumo";
import {
  ArrowBendDownRightIcon,
  CaretDownIcon,
  CaretRightIcon,
  CaretUpIcon,
  CloudArrowUpIcon,
  DotsThreeIcon,
  DownloadSimpleIcon,
  EyeIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
  LinkIcon,
  PencilSimpleIcon,
  ShareNetworkIcon,
  TrashIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { api, type Blob, type DirInfo, type Project } from "@/api";
import { useI18n } from "@/i18n";
import { useAsync, useDebounced } from "@/lib/hooks";
import { displayName, formatBytes, formatDate, formatRelative } from "@/lib/format";
import { uploads } from "@/lib/upload";
import { droppedFiles, pickedFolder, uploadTree, type TreeFile } from "@/lib/tree";
import { copyText, toast } from "@/lib/toast";
import { ErrorState, Loading } from "@/components/Page";
import { ConfirmDialog, FormDialog } from "@/components/Dialogs";
import { ShareDialog } from "@/components/ShareDialog";
import { SearchInput } from "@/components/SearchInput";
import { FileIcon } from "@/components/FileIcon";
import { Pager } from "@/components/Pager";

type SortKey = "name" | "size" | "created_at";
/** Search results (all files of the project) come in numbered pages. */
const PER_PAGE = 50;
/** A folder loads this many entries at a time. */
const DIR_PAGE = 200;

const ROOT: DirInfo = { id: null, path: "", parents: [] };
const validName = (name: string) => name.length > 0 && name.length <= 255 && !/[/\\]/.test(name) && name !== "." && name !== "..";
const dirOf = (path: string) => path.split("/").slice(0, -1).join("/");
/** Link to a folder of the files tab; the folder is kept in ?path=. */
const folderHref = (path: string) => (path ? `?path=${encodeURIComponent(path)}` : "?");

export function FilesTab({ project, onChanged }: { project: Project; onChanged: () => void }) {
  const { t, lang, errMsg } = useI18n();
  const canEdit = project.role !== "viewer";
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const searching = dq !== "";
  const [sort, setSort] = useState<SortKey>("name");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<Blob | null>(null);
  const [sharing, setSharing] = useState<Blob | null>(null);
  const [deleting, setDeleting] = useState<Blob[] | null>(null);
  const [moving, setMoving] = useState<Blob[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // A search covers the whole project; otherwise the folder in the URL is listed.
  const list = useAsync(
    () =>
      searching
        ? api.blobs.list(project.id, { q: dq, sort, order, limit: PER_PAGE, offset: (page - 1) * PER_PAGE })
        : api.blobs.list(project.id, { path: path || "/", sort, order, limit: DIR_PAGE }),
    [project.id, path, dq, sort, order, page],
  );
  // Entries of the folder loaded after its first page, and where to continue.
  const [more, setMore] = useState<{ blobs: Blob[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setMore(null), [list.data]);
  const blobs = [...(list.data?.blobs ?? []), ...(more?.blobs ?? [])];
  const cursor = searching ? null : more ? more.cursor : (list.data?.next_cursor ?? null);
  const dir = list.data?.dir ?? ROOT;
  // What uploads and new folders go into: the folder shown (the root while searching).
  const here = searching ? ROOT : dir;

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const r = await api.blobs.list(project.id, { path: path || "/", sort, order, limit: DIR_PAGE, cursor });
      setMore((m) => ({ blobs: [...(m?.blobs ?? []), ...r.blobs], cursor: r.next_cursor }));
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => setPage(1), [dq, sort, order]);
  useEffect(() => setQ(""), [path]);
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

  const changed = () => {
    list.reload();
    onChanged();
  };

  const startUpload = async (files: TreeFile[] | Promise<TreeFile[]>) => {
    try {
      const all = await files;
      if (all.length === 0) return;
      await uploadTree(project, { id: here.id, path: here.path }, all);
      // New folders show up before their files finish.
      if (all.some((f) => f.dir)) list.reload();
    } catch (e) {
      toast.error(errMsg(e));
    }
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
    void startUpload(droppedFiles(e.dataTransfer));
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
  const picked = blobs.filter((b) => selected.has(b.id));
  const upload = (
    <DropdownMenu>
      <DropdownMenu.Trigger render={<Button variant="primary" icon={UploadSimpleIcon}>{t("project.upload")}</Button>} />
      <DropdownMenu.Content align="end">
        <DropdownMenu.Item icon={UploadSimpleIcon} onClick={() => fileInput.current?.click()}>
          {t("project.uploadFiles")}
        </DropdownMenu.Item>
        <DropdownMenu.Item icon={FolderOpenIcon} onClick={() => folderInput.current?.click()}>
          {t("project.uploadFolder")}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );

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
          <>
            <Button variant="secondary" icon={ArrowBendDownRightIcon} onClick={() => setMoving(picked)}>
              {t("project.moveSelected")} ({selected.size})
            </Button>
            <Button variant="secondary-destructive" icon={TrashIcon} onClick={() => setDeleting(picked)}>
              {t("project.deleteSelected")} ({selected.size})
            </Button>
          </>
        )}
        {canEdit && (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void startUpload(Array.from(e.target.files ?? []).map((file) => ({ file, dir: "" })));
                e.target.value = "";
              }}
            />
            <input
              ref={folderInput}
              type="file"
              multiple
              hidden
              {...{ webkitdirectory: "" }}
              onChange={(e) => {
                void startUpload(pickedFolder(e.target.files!));
                e.target.value = "";
              }}
            />
            <Button variant="secondary" icon={FolderPlusIcon} onClick={() => setCreating(true)}>
              {t("project.newFolder")}
            </Button>
            {upload}
          </>
        )}
      </div>

      {searching ? (
        <div className="text-sm text-kumo-subtle">{t("project.searchResults")}</div>
      ) : (
        <FolderCrumbs root={project.name} dir={dir} />
      )}

      {!canEdit && <Banner variant="secondary" title={t("project.readonly")} size="sm" />}
      {list.error != null && <ErrorState error={list.error} onRetry={list.reload} />}

      {list.loading && !list.data ? (
        <Loading />
      ) : list.error != null ? null : blobs.length === 0 && !searching ? (
        <Empty
          icon={<CloudArrowUpIcon size={48} weight="duotone" />}
          title={t(dir.id ? "project.emptyDir" : "project.emptyTitle")}
          description={canEdit ? t("project.emptyDesc") : undefined}
          commandLine={canEdit && !dir.id ? t("project.emptyCli", { name: project.name }) : undefined}
          contents={canEdit && upload}
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
                {blobs.map((b) => {
                  const isDir = b.kind === "dir";
                  const nameClass =
                    "flex min-w-0 items-center gap-2.5 font-medium text-kumo-default no-underline hover:text-kumo-link hover:underline";
                  return (
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
                        {isDir ? (
                          <Link to={folderHref(b.path)} className={nameClass} title={b.name}>
                            <FolderSimpleIcon size={18} weight="duotone" className="shrink-0 text-kumo-brand" />
                            <span className="truncate">{b.name}</span>
                          </Link>
                        ) : (
                          <a href={api.blobs.downloadHref(b.id, true)} target="_blank" rel="noreferrer" className={nameClass} title={b.name}>
                            <FileIcon name={b.name} type={b.content_type} />
                            <span className="truncate">{b.name}</span>
                          </a>
                        )}
                        {searching && b.parent_id && (
                          <Link
                            to={folderHref(dirOf(b.path))}
                            className="mt-0.5 ml-7 block truncate text-xs text-kumo-subtle no-underline hover:underline"
                          >
                            {t("project.inFolder", { path: dirOf(b.path) })}
                          </Link>
                        )}
                      </Table.Cell>
                      <Table.Cell className="text-right whitespace-nowrap tabular-nums">{isDir ? "–" : formatBytes(b.size)}</Table.Cell>
                      <Table.Cell className="hidden text-kumo-subtle lg:table-cell">{b.via_inbox ? t("inbox.uploader") : displayName(b.uploader)}</Table.Cell>
                      <Table.Cell className="whitespace-nowrap text-kumo-subtle" title={formatDate(b.created_at, lang)}>
                        {formatRelative(b.created_at, lang)}
                      </Table.Cell>
                      <Table.Cell className="hidden text-right tabular-nums md:table-cell">{isDir ? "–" : b.download_count}</Table.Cell>
                      <Table.Cell className="text-right">
                        <BlobMenu
                          blob={b}
                          canEdit={canEdit}
                          onCopyLink={() => copyLink(b)}
                          onRename={() => setRenaming(b)}
                          onShare={() => setSharing(b)}
                          onMove={() => setMoving([b])}
                          onDelete={() => setDeleting([b])}
                        />
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
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

      {searching && <Pager page={page} setPage={setPage} perPage={PER_PAGE} total={list.data?.total ?? 0} />}
      {cursor && (
        <div className="flex justify-center">
          <Button variant="secondary" loading={loadingMore} onClick={loadMore}>
            {t("project.loadMore")}
          </Button>
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-kumo-brand bg-kumo-base/85">
          <div className="flex flex-col items-center gap-2 text-kumo-default">
            <CloudArrowUpIcon size={40} weight="duotone" className="text-kumo-brand" />
            <span className="font-medium">
              {t("project.dropHere", { name: here.path ? `${project.name}/${here.path}` : project.name })}
            </span>
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
      <NewFolderDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreate={async (name) => {
          await api.blobs.mkdir(project.id, { path: name, parent_id: here.id });
          toast.success(t("project.folderCreated"));
          list.reload();
        }}
      />
      <MoveDialog
        project={project}
        items={moving}
        start={here}
        onClose={() => setMoving(null)}
        onMoved={(n) => {
          toast.success(t("project.moved", { n }));
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
            : t(deleting?.some((b) => b.kind === "dir") ? "project.deleteItemsTitle" : "project.deleteFilesTitle", { n: deleting?.length ?? 0 })
        }
        description={t(deleting?.some((b) => b.kind === "dir") ? "project.deleteDirsDesc" : "project.deleteFilesDesc")}
        onConfirm={async () => {
          const ids = deleting!.map((b) => b.id);
          const dirs = deleting!.some((b) => b.kind === "dir");
          if (ids.length === 1) await api.blobs.remove(ids[0]);
          else await api.blobs.bulkDelete(project.id, ids);
          toast.success(t(dirs ? "project.deletedItems" : "project.deleted", { n: ids.length }));
          changed();
        }}
      />
    </div>
  );
}

/** Where the listing is: the project, then each folder down to the current one. */
function FolderCrumbs({ root, dir, onPick }: { root: string; dir: DirInfo; onPick?: (path: string) => void }) {
  const names = dir.path ? dir.path.split("/") : [];
  const crumb = (label: string, path: string, current: boolean) =>
    current ? (
      <span className="truncate font-medium text-kumo-default">{label}</span>
    ) : onPick ? (
      <button
        type="button"
        onClick={() => onPick(path)}
        className="cursor-pointer truncate bg-transparent p-0 font-[inherit] text-kumo-subtle hover:text-kumo-link hover:underline"
      >
        {label}
      </button>
    ) : (
      <Link to={folderHref(path)} className="truncate text-kumo-subtle no-underline hover:text-kumo-link hover:underline">
        {label}
      </Link>
    );
  return (
    <nav className="flex min-w-0 flex-wrap items-center gap-1.5 text-sm">
      <FolderSimpleIcon size={16} weight="duotone" className="shrink-0 text-kumo-subtle" />
      {crumb(root, "", names.length === 0)}
      {names.map((name, i) => (
        <Fragment key={i}>
          <CaretRightIcon size={12} className="shrink-0 text-kumo-subtle" />
          {crumb(name, names.slice(0, i + 1).join("/"), i === names.length - 1)}
        </Fragment>
      ))}
    </nav>
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
  onMove,
  onDelete,
}: {
  blob: Blob;
  canEdit: boolean;
  onCopyLink: () => void;
  onRename: () => void;
  onShare: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const isDir = blob.kind === "dir";
  // A viewer can do nothing with a folder but open it, which its name does.
  if (isDir && !canEdit) return null;
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={<Button variant="ghost" size="sm" shape="square" icon={DotsThreeIcon} aria-label={t("common.actions")} />}
      />
      <DropdownMenu.Content align="end">
        {!isDir && (
          <>
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
          </>
        )}
        {canEdit && (
          <>
            <DropdownMenu.Item icon={ShareNetworkIcon} onClick={onShare}>
              {t("common.share")}
            </DropdownMenu.Item>
            <DropdownMenu.Item icon={PencilSimpleIcon} onClick={onRename}>
              {t("common.rename")}
            </DropdownMenu.Item>
            <DropdownMenu.Item icon={ArrowBendDownRightIcon} onClick={onMove}>
              {t("project.move")}
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
  return (
    <FormDialog
      open={blob != null}
      onOpenChange={(o) => !o && onClose()}
      title={t(blob?.kind === "dir" ? "project.renameFolderTitle" : "project.renameTitle")}
      submitLabel={t("common.rename")}
      submitDisabled={!validName(name) || name === blob?.name}
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

function NewFolderDialog({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (name: string) => Promise<void> }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  useEffect(() => {
    if (open) setName("");
  }, [open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={t("project.newFolder")}
      submitLabel={t("common.create")}
      submitDisabled={!validName(name.trim())}
      onSubmit={async () => {
        await onCreate(name.trim());
        onClose();
      }}
    >
      <Input label={t("project.folderName")} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
    </FormDialog>
  );
}

/** Picks the folder to move `items` into: browse the project's folders, then "Move here". */
function MoveDialog({
  project,
  items,
  start,
  onClose,
  onMoved,
}: {
  project: Project;
  items: Blob[] | null;
  /** The folder the picker opens in. */
  start: DirInfo;
  onClose: () => void;
  onMoved: (n: number) => void;
}) {
  const { t } = useI18n();
  const [at, setAt] = useState("");
  useEffect(() => {
    if (items) setAt(start.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const open = items != null;
  const list = useAsync(
    async () => (open ? api.blobs.list(project.id, { path: at || "/", sort: "name", order: "asc", limit: 1000 }) : undefined),
    [project.id, at, open],
  );
  const dir = list.data?.dir ?? ROOT;
  const movingIds = new Set(items?.map((b) => b.id));
  // A folder cannot move into itself: it is not offered as a place to go.
  const folders = (list.data?.blobs ?? []).filter((b) => b.kind === "dir" && !movingIds.has(b.id));
  const sameplace = items?.every((b) => b.parent_id === dir.id) ?? true;
  return (
    <FormDialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={items?.length === 1 ? t("project.moveOneTitle", { name: items[0].name }) : t("project.moveTitle", { n: items?.length ?? 0 })}
      submitLabel={t("project.moveHere")}
      submitDisabled={sameplace || list.loading || list.error != null}
      onSubmit={async () => {
        const { moved } = await api.blobs.move(project.id, items!.map((b) => b.id), dir.id);
        onClose();
        onMoved(moved);
      }}
    >
      <FolderCrumbs root={project.name} dir={dir} onPick={setAt} />
      <div className="max-h-72 min-h-32 overflow-y-auto rounded-lg border border-kumo-line">
        {list.error != null ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : list.loading ? (
          <div className="flex h-32 items-center justify-center text-kumo-subtle">
            <Loader size={18} />
          </div>
        ) : folders.length === 0 ? (
          <p className="m-0 px-4 py-10 text-center text-sm text-kumo-subtle">{t("project.noFolders")}</p>
        ) : (
          <ul className="m-0 list-none divide-y divide-kumo-hairline p-0">
            {folders.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setAt(f.path)}
                  className="flex w-full cursor-pointer items-center gap-2.5 bg-transparent px-4 py-2.5 text-left font-[inherit] text-kumo-default hover:bg-kumo-recessed"
                >
                  <FolderSimpleIcon size={18} weight="duotone" className="shrink-0 text-kumo-brand" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <CaretRightIcon size={12} className="shrink-0 text-kumo-subtle" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </FormDialog>
  );
}
