import { useState } from "react";
import { Badge, Button, Empty, LayerCard, Table } from "@cloudflare/kumo";
import {
  ArrowSquareOutIcon,
  CopyIcon,
  DownloadSimpleIcon,
  FolderSimpleIcon,
  LockSimpleIcon,
  ShareNetworkIcon,
  TerminalWindowIcon,
  TrashIcon,
  TrayArrowDownIcon,
  UploadSimpleIcon,
} from "@phosphor-icons/react";
import { Link } from "react-router";
import { api, type Share } from "@/api";
import { useI18n } from "@/i18n";
import { displayName, formatBytes, formatDate, formatRelative } from "@/lib/format";
import { copyText, toast } from "@/lib/toast";
import { ConfirmDialog } from "./Dialogs";
import { FileIcon } from "./FileIcon";

/** Download links: downloads (of the limit). Upload links: files and bytes received (of the limits). */
function Usage({ share: s }: { share: Share }) {
  const of = (n: string | null) => n != null && <span className="text-kumo-subtle"> / {n}</span>;
  if (s.mode === "download") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <DownloadSimpleIcon className="text-kumo-subtle" />
        {s.download_count}
        {of(s.max_downloads != null ? String(s.max_downloads) : null)}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <UploadSimpleIcon className="text-kumo-subtle" />
      {s.upload_count}
      {of(s.max_uploads != null ? String(s.max_uploads) : null)}
      <span className="text-kumo-subtle">·</span>
      {formatBytes(s.upload_bytes)}
      {of(s.max_upload_bytes != null ? formatBytes(s.max_upload_bytes) : null)}
    </span>
  );
}

const usedUp = (s: Share) =>
  s.mode === "download"
    ? s.max_downloads != null && s.download_count >= s.max_downloads
    : (s.max_uploads != null && s.upload_count >= s.max_uploads) ||
      (s.max_upload_bytes != null && s.upload_bytes >= s.max_upload_bytes);

export function SharesTable({
  shares,
  showProject,
  onDeleted,
  emptyAction,
}: {
  shares: Share[];
  showProject?: boolean;
  onDeleted: () => void;
  emptyAction?: React.ReactNode;
}) {
  const { t, lang } = useI18n();
  const [deleting, setDeleting] = useState<Share | null>(null);

  if (shares.length === 0) {
    return (
      <Empty
        icon={<ShareNetworkIcon size={48} weight="duotone" />}
        title={t("share.emptyTitle")}
        description={t("share.emptyDesc")}
        contents={emptyAction}
      />
    );
  }

  const now = Date.now();
  return (
    <>
      <LayerCard className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{t("share.target")}</Table.Head>
                <Table.Head>{t("common.status")}</Table.Head>
                <Table.Head>{t("share.expiry")}</Table.Head>
                <Table.Head className="text-right">{t("share.usage")}</Table.Head>
                <Table.Head className="hidden text-right md:table-cell">{t("share.views")}</Table.Head>
                <Table.Head className="hidden lg:table-cell">{t("common.created")}</Table.Head>
                <Table.Head className="w-36" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {shares.map((s) => {
                const expired = s.expires_at != null && s.expires_at < now;
                const exhausted = usedUp(s);
                return (
                  <Table.Row key={s.id}>
                    <Table.Cell className="max-w-[24rem]">
                      <div className="flex min-w-0 items-center gap-2.5">
                        {s.mode === "upload" ? (
                          <TrayArrowDownIcon size={18} weight="duotone" className="shrink-0 text-kumo-brand" />
                        ) : s.blob_name ? (
                          <FileIcon name={s.blob_name} type="" />
                        ) : (
                          <FolderSimpleIcon size={18} weight="duotone" className="shrink-0 text-kumo-subtle" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {s.mode === "upload" ? t("share.inbox") : (s.blob_name ?? t("share.wholeProject"))}
                          </div>
                          {showProject && (
                            <Link
                              to={`/projects/${s.project_id}`}
                              className="block truncate text-xs text-kumo-subtle no-underline hover:underline"
                            >
                              {s.project_name}
                            </Link>
                          )}
                        </div>
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-wrap gap-1">
                        {expired ? (
                          <Badge variant="neutral">{t("share.expired")}</Badge>
                        ) : exhausted ? (
                          <Badge variant="neutral">{t("share.exhausted")}</Badge>
                        ) : s.has_password ? (
                          <Badge variant="orange" icon={<LockSimpleIcon />}>
                            {t("share.protected")}
                          </Badge>
                        ) : (
                          <Badge variant="green">{t("share.public")}</Badge>
                        )}
                      </div>
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap text-kumo-subtle" title={formatDate(s.expires_at, lang)}>
                      {s.expires_at ? formatRelative(s.expires_at, lang) : t("common.never")}
                    </Table.Cell>
                    <Table.Cell className="text-right whitespace-nowrap tabular-nums">
                      <Usage share={s} />
                    </Table.Cell>
                    <Table.Cell className="hidden text-right tabular-nums md:table-cell">{s.view_count}</Table.Cell>
                    <Table.Cell className="hidden whitespace-nowrap text-kumo-subtle lg:table-cell">
                      {formatRelative(s.created_at, lang)} · {displayName(s.creator)}
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          icon={CopyIcon}
                          title={t("common.copyLink")}
                          onClick={async () => {
                            await copyText(s.url);
                            toast.success(t("common.copied"));
                          }}
                        />
                        {s.download_url && !s.has_password && (
                          <Button
                            variant="ghost"
                            size="sm"
                            shape="square"
                            icon={TerminalWindowIcon}
                            title={t("share.copyDirectLink")}
                            onClick={async () => {
                              await copyText(s.download_url!);
                              toast.success(t("common.copied"));
                            }}
                          />
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          icon={ArrowSquareOutIcon}
                          title={t("common.preview")}
                          onClick={() => window.open(s.url, "_blank")}
                        />
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          icon={TrashIcon}
                          title={t("common.delete")}
                          onClick={() => setDeleting(s)}
                        />
                      </div>
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>
      </LayerCard>
      <ConfirmDialog
        open={deleting != null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t("share.deleteTitle")}
        description={t("share.deleteDesc")}
        onConfirm={async () => {
          await api.shares.remove(deleting!.id);
          toast.success(t("share.deleted"));
          onDeleted();
        }}
      />
    </>
  );
}
