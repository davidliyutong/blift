import { Fragment, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useParams } from "react-router";
import { Badge, Banner, Button, LinkButton, SensitiveInput } from "@cloudflare/kumo";
import {
  CaretRightIcon,
  ClockCountdownIcon,
  DownloadSimpleIcon,
  FolderSimpleIcon,
  LinkBreakIcon,
  LockSimpleIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";
import { api, ApiError } from "@/api";
import type { PublicBlob } from "@/api/types";
import { useI18n } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { useSession } from "@/lib/session";
import { formValues } from "@/lib/form";
import { formatBytes, formatRelative } from "@/lib/format";
import { Card, CenteredLayout } from "@/components/CenteredLayout";
import { Loading } from "@/components/Page";
import { FileIcon } from "@/components/FileIcon";
import { ShareUploadView, UploadLimits } from "./ShareUpload";

const accessKey = (token: string) => `blift.share.${token}`;
/** Files per request; long project shares load further pages on demand. */
const PAGE = 200;

export function PublicSharePage() {
  const { t, lang, errMsg } = useI18n();
  const { info } = useSession();
  const { token = "" } = useParams();
  const [access, setAccess] = useState(() => sessionStorage.getItem(accessKey(token)) ?? undefined);
  // The folder of a project or folder share being looked at; undefined = the top of the share.
  const [dirId, setDirId] = useState<string>();
  const res = useAsync(() => api.public.share(token, access, { parent_id: dirId, limit: PAGE }), [token, access, dirId]);
  const [unlocking, setUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState<unknown>(null);
  // Pages loaded after the first one, and where to continue.
  const [more, setMore] = useState<{ blobs: PublicBlob[]; cursor: string | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<unknown>(null);
  useEffect(() => setMore(null), [res.data]);

  const loadMore = async (cursor: string) => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      const r = await api.public.share(token, access, { parent_id: dirId, cursor, limit: PAGE });
      setMore((m) => ({ blobs: [...(m?.blobs ?? []), ...(r.blobs ?? [])], cursor: r.next_cursor ?? null }));
    } catch (err) {
      setMoreError(err);
    } finally {
      setLoadingMore(false);
    }
  };

  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    const { password = "" } = formValues(e);
    setUnlocking(true);
    setUnlockError(null);
    try {
      const r = await api.public.unlock(token, password);
      sessionStorage.setItem(accessKey(token), r.access_token);
      setAccess(r.access_token);
    } catch (err) {
      setUnlockError(err);
    } finally {
      setUnlocking(false);
    }
  };

  const footer = t("pub.poweredBy", { name: info.name });

  if (res.loading && !res.data) {
    return (
      <CenteredLayout footer={footer}>
        <Loading />
      </CenteredLayout>
    );
  }

  if (res.error || !res.data) {
    const code = res.error instanceof ApiError ? res.error.code : "";
    const gone = code === "share_expired" || code === "share_exhausted";
    return (
      <CenteredLayout footer={footer} title={t("pub.notFound")}>
        <Card className="flex flex-col items-center gap-3 text-center">
          {gone ? (
            <ClockCountdownIcon size={48} weight="duotone" className="text-kumo-subtle" />
          ) : (
            <LinkBreakIcon size={48} weight="duotone" className="text-kumo-subtle" />
          )}
          <h1 className="m-0 text-xl font-semibold">
            {gone ? errMsg(res.error) : code === "not_found" ? t("pub.notFound") : errMsg(res.error)}
          </h1>
          <p className="m-0 text-sm text-kumo-subtle">{gone ? t("pub.expiredDesc") : t("pub.notFoundDesc")}</p>
        </Card>
      </CenteredLayout>
    );
  }

  const { share } = res.data;
  const metaWith = (badges: ReactNode) => (
    <div className="flex flex-wrap items-center justify-center gap-2 text-xs text-kumo-subtle">
      <span>{t("pub.sharedBy", { name: share.creator })}</span>
      {share.expires_at && (
        <>
          <span>·</span>
          <span>{t("pub.expires", { when: formatRelative(share.expires_at, lang) })}</span>
        </>
      )}
      {badges}
    </div>
  );
  const left =
    share.mode === "download" && share.max_downloads != null ? Math.max(0, share.max_downloads - share.download_count) : null;
  const meta = metaWith(
    share.mode === "upload" ? (
      <UploadLimits share={share} />
    ) : (
      left != null && <Badge variant="neutral">{t("pub.downloadsLeft", { n: left })}</Badge>
    ),
  );

  if (share.locked) {
    return (
      <CenteredLayout footer={footer} title={share.name}>
        <Card>
          <div className="mb-6 flex flex-col items-center gap-3 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-kumo-recessed">
              <LockSimpleIcon size={28} weight="duotone" className="text-kumo-brand" />
            </div>
            <h1 className="m-0 text-xl font-semibold break-all">{share.name}</h1>
            <p className="m-0 text-sm text-kumo-subtle">{t("pub.locked")}</p>
            {meta}
          </div>
          <form method="post" className="flex flex-col gap-4" onSubmit={unlock}>
            {unlockError != null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={errMsg(unlockError)} />
            )}
            <SensitiveInput
              label={t("common.password")}
              name="password"
              autoFocus
              required
            />
            <Button type="submit" variant="primary" loading={unlocking} className="w-full justify-center">
              {t("pub.unlock")}
            </Button>
          </form>
        </Card>
      </CenteredLayout>
    );
  }

  if (share.mode === "upload") {
    return <ShareUploadView token={token} access={access} share={share} meta={metaWith} footer={footer} />;
  }

  const blobs = res.data.blobs && [...res.data.blobs, ...(more?.blobs ?? [])];
  const cursor = more ? more.cursor : (res.data.next_cursor ?? null);
  const dir = res.data.dir;
  const crumbs = dir && dir.id ? [...dir.parents, { id: dir.id, name: dir.path.split("/").pop()! }] : [];
  const crumbClass = "cursor-pointer truncate bg-transparent p-0 font-[inherit] text-kumo-subtle hover:text-kumo-link hover:underline";
  const href = (blobId: string) => api.public.downloadHref(token, blobId, access);

  if (share.kind === "blob" && blobs?.length === 1) {
    const b = blobs[0];
    return (
      <CenteredLayout footer={footer} title={b.name}>
        <Card className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-16 items-center justify-center rounded-2xl bg-kumo-recessed">
            <FileIcon name={b.name} type={b.content_type} size={34} />
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-xl font-semibold break-all">{b.name}</h1>
            <span className="text-sm text-kumo-subtle">{formatBytes(b.size)}</span>
          </div>
          {meta}
          <LinkButton href={href(b.id)} variant="primary" size="lg" icon={DownloadSimpleIcon} className="mt-2 w-full justify-center">
            {t("pub.downloadAll")}
          </LinkButton>
        </Card>
      </CenteredLayout>
    );
  }

  return (
    <CenteredLayout footer={footer} title={share.name} width="max-w-[720px]">
      <Card className="p-0 md:p-0">
        <div className="flex flex-col items-center gap-2 border-b border-kumo-line px-6 py-6 text-center">
          <FolderSimpleIcon size={36} weight="duotone" className="text-kumo-brand" />
          <h1 className="m-0 text-xl font-semibold break-all">{share.name}</h1>
          <span className="text-sm text-kumo-subtle">
            {share.file_count != null && share.total_bytes != null
              ? t("pub.files", { n: share.file_count, size: formatBytes(share.total_bytes) })
              : t("pub.folder")}
          </span>
          {meta}
        </div>
        {crumbs.length > 0 && (
          <nav className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-kumo-line px-6 py-3 text-sm">
            <button type="button" className={crumbClass} onClick={() => setDirId(undefined)}>
              {share.name}
            </button>
            {crumbs.map((c, i) => (
              <Fragment key={c.id}>
                <CaretRightIcon size={12} className="shrink-0 text-kumo-subtle" />
                {i === crumbs.length - 1 ? (
                  <span className="truncate font-medium">{c.name}</span>
                ) : (
                  <button type="button" className={crumbClass} onClick={() => setDirId(c.id)}>
                    {c.name}
                  </button>
                )}
              </Fragment>
            ))}
          </nav>
        )}
        {blobs && blobs.length > 0 ? (
          <ul className="m-0 list-none divide-y divide-kumo-hairline p-0">
            {blobs.map((b) =>
              b.kind === "dir" ? (
                <li key={b.id}>
                  <button
                    type="button"
                    onClick={() => setDirId(b.id)}
                    className="flex w-full cursor-pointer items-center gap-3 bg-transparent px-6 py-3 text-left font-[inherit] text-kumo-default hover:bg-kumo-recessed"
                  >
                    <FolderSimpleIcon size={18} weight="duotone" className="shrink-0 text-kumo-brand" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium" title={b.name}>
                      {b.name}
                    </span>
                    <CaretRightIcon size={14} className="shrink-0 text-kumo-subtle" />
                  </button>
                </li>
              ) : (
                <li key={b.id} className="flex items-center gap-3 px-6 py-3">
                  <FileIcon name={b.name} type={b.content_type} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" title={b.name}>
                      {b.name}
                    </div>
                    <div className="text-xs text-kumo-subtle">{formatBytes(b.size)}</div>
                  </div>
                  <LinkButton href={href(b.id)} size="sm" variant="secondary" icon={DownloadSimpleIcon}>
                    {t("common.download")}
                  </LinkButton>
                </li>
              ),
            )}
          </ul>
        ) : (
          <p className="m-0 px-6 py-10 text-center text-sm text-kumo-subtle">{t(crumbs.length ? "pub.emptyDir" : "pub.empty")}</p>
        )}
        {cursor && blobs && (
          <div className="flex flex-col items-center gap-3 border-t border-kumo-line px-6 py-4">
            {moreError != null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={errMsg(moreError)} />
            )}
            <Button variant="secondary" loading={loadingMore} onClick={() => loadMore(cursor)}>
              {t("pub.loadMore")}
            </Button>
          </div>
        )}
      </Card>
    </CenteredLayout>
  );
}
