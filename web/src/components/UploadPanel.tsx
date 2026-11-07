import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Dialog, Meter, cn } from "@cloudflare/kumo";
import { CaretDownIcon, CaretUpIcon, CheckCircleIcon, WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { useI18n } from "@/i18n";
import { uploads, type UploadItem } from "@/lib/upload";
import { formatBytes } from "@/lib/format";

interface PendingConfirm {
  name: string;
  resolve: (ok: boolean) => void;
}

export function UploadPanel() {
  const { t } = useI18n();
  const items = useSyncExternalStore(uploads.subscribe, uploads.snapshot);
  const [collapsed, setCollapsed] = useState(false);
  const [confirms, setConfirms] = useState<PendingConfirm[]>([]);

  useEffect(() => {
    uploads.confirmOverwrite = (name) =>
      new Promise<boolean>((resolve) => setConfirms((q) => [...q, { name, resolve }]));
  }, []);

  const answer = (ok: boolean) => {
    const [first, ...rest] = confirms;
    first?.resolve(ok);
    setConfirms(rest);
  };

  const done = items.filter((i) => i.status === "done").length;
  const active = items.some((i) => i.status === "queued" || i.status === "uploading" || i.status === "completing");

  return (
    <>
      {items.length > 0 && (
        <div className="fixed right-4 bottom-4 z-40 w-[min(380px,calc(100vw-2rem))] overflow-hidden rounded-lg bg-kumo-base shadow-lg ring ring-kumo-line">
          <div className="flex items-center gap-2 border-b border-kumo-line px-4 py-2.5">
            <div className="flex-1 text-sm font-semibold">
              {t("upload.panelTitle")}
              <span className="ml-2 font-normal text-kumo-subtle">
                {t("upload.summary", { done, total: items.length })}
              </span>
            </div>
            {!active && (
              <Button size="xs" variant="ghost" onClick={() => uploads.clearFinished()}>
                {t("upload.clear")}
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost"
              shape="square"
              icon={collapsed ? CaretUpIcon : CaretDownIcon}
              aria-label="toggle"
              onClick={() => setCollapsed((c) => !c)}
            />
          </div>
          {!collapsed && (
            <ul className="max-h-80 divide-y divide-kumo-hairline overflow-y-auto">
              {items.map((it) => (
                <UploadRow key={it.id} item={it} />
              ))}
            </ul>
          )}
        </div>
      )}

      <Dialog.Root open={confirms.length > 0} onOpenChange={(open) => !open && answer(false)}>
        <Dialog size="base" className="p-6">
          <Dialog.Title className="text-lg font-semibold">{t("upload.overwriteTitle")}</Dialog.Title>
          <Dialog.Description className="mt-2 text-kumo-subtle">
            {t("upload.overwriteDesc", { name: confirms[0]?.name ?? "" })}
          </Dialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => answer(false)}>
              {t("upload.skip")}
            </Button>
            <Button variant="primary" onClick={() => answer(true)}>
              {t("upload.replace")}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </>
  );
}

function UploadRow({ item }: { item: UploadItem }) {
  const { t, errMsg } = useI18n();
  const pct = item.total ? Math.floor((item.loaded / item.total) * 100) : 100;
  const running = item.status === "uploading" || item.status === "completing" || item.status === "queued";
  const statusText =
    item.status === "uploading"
      ? `${formatBytes(item.loaded)} / ${formatBytes(item.total)}`
      : item.status === "failed"
        ? errMsg(item.error)
        : t(`upload.${item.status}`);

  return (
    <li className="flex items-start gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {item.status === "done" && <CheckCircleIcon className="shrink-0 text-kumo-success" weight="fill" />}
          {item.status === "failed" && <WarningCircleIcon className="shrink-0 text-kumo-danger" weight="fill" />}
          <span className="truncate text-sm font-medium" title={item.name}>
            {item.name}
          </span>
        </div>
        <div className="mt-0.5 truncate text-xs text-kumo-subtle">{item.projectName}</div>
        {running && (
          <Meter label={statusText} value={pct} customValue={`${pct}%`} className="mt-2" />
        )}
        {!running && (
          <div className={cn("mt-1 text-xs", item.status === "failed" ? "text-kumo-danger" : "text-kumo-subtle")}>
            {item.status === "done" ? formatBytes(item.total) : statusText}
          </div>
        )}
      </div>
      {running && (
        <Button
          size="xs"
          variant="ghost"
          shape="square"
          icon={XIcon}
          aria-label={t("upload.cancel")}
          onClick={() => uploads.cancel(item.id)}
        />
      )}
    </li>
  );
}
