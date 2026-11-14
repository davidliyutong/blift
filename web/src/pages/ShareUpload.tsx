import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type DragEvent, type ReactNode } from "react";
import { Badge, Button, cn } from "@cloudflare/kumo";
import { TrayArrowDownIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import type { PublicShare } from "@/api";
import { useT } from "@/i18n";
import { formatBytes } from "@/lib/format";
import { shareUploadApi, UploadManager } from "@/lib/upload";
import { Card, CenteredLayout } from "@/components/CenteredLayout";
import { UploadRow } from "@/components/UploadPanel";

type UploadShare = Extract<PublicShare, { mode: "upload" }>;

/** What an upload link still takes, less the files sent from this page (`files`, `bytes`). */
export function UploadLimits({ share, files = 0, bytes = 0 }: { share: UploadShare; files?: number; bytes?: number }) {
  const t = useT();
  const filesLeft = share.max_uploads != null ? Math.max(0, share.max_uploads - share.upload_count - files) : null;
  const bytesLeft = share.max_upload_bytes != null ? Math.max(0, share.max_upload_bytes - share.upload_bytes - bytes) : null;
  return (
    <>
      {filesLeft != null && <Badge variant="neutral">{t("pub.uploadsLeft", { n: filesLeft })}</Badge>}
      {bytesLeft != null && <Badge variant="neutral">{t("pub.bytesLeft", { size: formatBytes(bytesLeft) })}</Badge>}
    </>
  );
}

/**
 * An unlocked upload link (/s/:token of a share with mode "upload"): anonymous uploads into the
 * project. Uploaders see only their own uploads.
 */
export function ShareUploadView({
  token,
  access,
  share,
  meta,
  footer,
}: {
  token: string;
  access?: string;
  share: UploadShare;
  /** Who shared it and when it expires, followed by `badges`. */
  meta: (badges: ReactNode) => ReactNode;
  footer: string;
}) {
  const t = useT();
  const manager = useMemo(() => new UploadManager(shareUploadApi(token, access)), [token, access]);
  const items = useSyncExternalStore(manager.subscribe, manager.snapshot);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);

  const active = items.some((i) => i.status === "queued" || i.status === "uploading" || i.status === "completing");
  const sent = items.filter((i) => i.status === "done");
  const done = sent.length;
  const sentBytes = sent.reduce((sum, i) => sum + i.total, 0);

  // Leaving the page would abandon running uploads.
  useEffect(() => {
    if (!active) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [active]);

  const add = (files: FileList | File[] | null) => {
    if (files && files.length > 0) manager.add(token, share.name, Array.from(files));
  };

  const onDragEnter = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    add(Array.from(e.dataTransfer.files).filter((f) => f.size > 0 || f.type !== ""));
  };

  return (
    <CenteredLayout footer={footer} title={share.name} width="max-w-[560px]">
      <div onDragEnter={onDragEnter} onDragOver={(e) => e.preventDefault()} onDragLeave={onDragLeave} onDrop={onDrop}>
        <Card className="flex flex-col gap-5">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-kumo-recessed">
              <TrayArrowDownIcon size={28} weight="duotone" className="text-kumo-brand" />
            </div>
            <h1 className="m-0 text-xl font-semibold break-all">{share.name}</h1>
            <p className="m-0 text-sm text-kumo-subtle">{t("inbox.pubInvite", { name: share.creator })}</p>
            {share.description && <p className="m-0 text-sm text-pretty whitespace-pre-line">{share.description}</p>}
            {meta(<UploadLimits share={share} files={done} bytes={sentBytes} />)}
          </div>

          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-10 text-center transition-colors",
              dragging ? "border-kumo-brand bg-kumo-tint" : "border-kumo-line hover:bg-kumo-tint",
            )}
          >
            <UploadSimpleIcon size={32} className={dragging ? "text-kumo-brand" : "text-kumo-subtle"} />
            <span className="font-medium text-kumo-default">{t("inbox.pubDrop")}</span>
            <span className="text-xs text-pretty text-kumo-subtle">{t("inbox.pubPrivacy")}</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              add(e.target.files);
              e.target.value = "";
            }}
          />

          {items.length > 0 && (
            <div className="overflow-hidden rounded-lg ring ring-kumo-line">
              <div className="flex items-center gap-2 border-b border-kumo-line px-4 py-2.5">
                <span className="flex-1 text-sm font-semibold">
                  {active ? t("upload.summary", { done, total: items.length }) : t("inbox.pubDone", { n: done })}
                </span>
                {!active && (
                  <Button size="xs" variant="ghost" onClick={() => manager.clearFinished()}>
                    {t("upload.clear")}
                  </Button>
                )}
              </div>
              <ul className="m-0 max-h-96 list-none divide-y divide-kumo-hairline overflow-y-auto p-0">
                {items.map((it) => (
                  <UploadRow key={it.id} item={it} manager={manager} subtitle="" />
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </CenteredLayout>
  );
}
