import { useEffect, useState } from "react";
import { Banner, Button, ClipboardText, Input, Radio, Select, Switch } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, KeyIcon } from "@phosphor-icons/react";
import { api, type Share, type ShareMode } from "@/api";
import { useT } from "@/i18n";
import { GiB, randomPassword } from "@/lib/format";
import { FormDialog } from "./Dialogs";

const EXPIRY = { "1h": 3600, "1d": 86400, "7d": 7 * 86400, "30d": 30 * 86400, never: 0 } as const;
type ExpiryKey = keyof typeof EXPIRY;

/** "" = no limit. */
const count = (v: string) => (v ? Number(v) : null);

export function ShareDialog({
  open,
  onOpenChange,
  project,
  blob,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: { id: string; name: string };
  /** Share this file; without it the whole project (download link or inbox). */
  blob?: { id: string; name: string } | null;
  onCreated?: (s: Share) => void;
}) {
  const t = useT();
  const [mode, setMode] = useState<ShareMode>("download");
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<ExpiryKey>("7d");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [maxUploads, setMaxUploads] = useState("");
  const [maxUploadGiB, setMaxUploadGiB] = useState("");
  const [created, setCreated] = useState<{ share: Share; password: string } | null>(null);

  useEffect(() => {
    if (open) {
      setMode("download");
      setUsePassword(false);
      setPassword(randomPassword(8));
      setExpiry("7d");
      setMaxDownloads("");
      setMaxUploads("");
      setMaxUploadGiB("");
      setCreated(null);
    }
  }, [open]);

  const upload = !blob && mode === "upload";
  const target = blob?.name ?? project.name;

  if (created) {
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t(created.share.mode === "upload" ? "share.createdInbox" : "share.created")}
        footer={
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            {t("common.done")}
          </Button>
        }
      >
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">{t("share.link")}</span>
          <ClipboardText text={created.share.url} size="base" />
        </div>
        {created.share.download_url && !created.password && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("share.directLink")}</span>
            <ClipboardText text={created.share.download_url} size="base" />
            <p className="m-0 text-xs text-kumo-subtle">{t("share.directLinkHint")}</p>
          </div>
        )}
        {created.password && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("common.password")}</span>
            <ClipboardText text={created.password} size="base" />
            <Banner variant="default" icon={<KeyIcon />} title={t("share.copyPasswordToo")} size="sm" />
          </div>
        )}
      </FormDialog>
    );
  }

  const maxBytes = maxUploadGiB ? Math.round(Number(maxUploadGiB) * GiB) : null;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("share.createFor", { name: target })}
      submitLabel={t("share.create")}
      submitDisabled={(usePassword && password.length === 0) || (maxBytes != null && !(maxBytes > 0))}
      onSubmit={async () => {
        const share = await api.shares.create({
          project_id: project.id,
          mode: upload ? "upload" : "download",
          blob_id: blob?.id,
          password: usePassword ? password : undefined,
          expires_in: EXPIRY[expiry] || null,
          ...(upload
            ? { max_uploads: count(maxUploads), max_upload_bytes: maxBytes }
            : { max_downloads: count(maxDownloads) }),
        });
        setCreated({ share, password: usePassword ? password : "" });
        onCreated?.(share);
      }}
    >
      {blob ? (
        <div className="flex flex-col gap-1 rounded-lg bg-kumo-recessed px-4 py-3">
          <span className="text-xs text-kumo-subtle">{t("share.target")}</span>
          <span className="truncate font-medium">{blob.name}</span>
        </div>
      ) : (
        <Radio.Group
          legend={t("share.mode")}
          appearance="card"
          orientation="horizontal"
          value={mode}
          onValueChange={(v) => setMode(v as ShareMode)}
        >
          <Radio.Item value="download" label={t("share.mode.download")} description={t("share.mode.downloadDesc")} />
          <Radio.Item value="upload" label={t("share.mode.upload")} description={t("share.mode.uploadDesc")} />
        </Radio.Group>
      )}

      <Switch label={t("share.password")} checked={usePassword} onCheckedChange={setUsePassword} />
      {usePassword && (
        <div className="flex flex-col gap-2">
          <div className="flex items-end gap-2">
            <div className="min-w-0 flex-1">
              <Input
                className="w-full font-mono"
                label={t("common.password")}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </div>
            <Button type="button" variant="secondary" icon={ArrowsClockwiseIcon} onClick={() => setPassword(randomPassword(8))}>
              {t("share.generate")}
            </Button>
          </div>
          <p className="m-0 text-xs text-kumo-subtle">{t(upload ? "share.passwordHintUpload" : "share.passwordHint")}</p>
        </div>
      )}

      <Select
        label={t("share.expiry")}
        hideLabel={false}
        className="w-full"
        value={expiry}
        onValueChange={(v) => setExpiry(v as ExpiryKey)}
        items={{
          "1h": t("share.expiry.1h"),
          "1d": t("share.expiry.1d"),
          "7d": t("share.expiry.7d"),
          "30d": t("share.expiry.30d"),
          never: t("share.expiry.never"),
        }}
      />
      {upload ? (
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Input
            label={t("share.maxUploads")}
            description={t("share.limitHint")}
            type="number"
            min={1}
            value={maxUploads}
            onChange={(e) => setMaxUploads(e.target.value)}
            placeholder="∞"
          />
          <Input
            label={t("share.maxUploadSize")}
            description={t("share.limitHint")}
            type="number"
            min={0}
            step="any"
            value={maxUploadGiB}
            onChange={(e) => setMaxUploadGiB(e.target.value)}
            placeholder="∞"
          />
        </div>
      ) : (
        <Input
          label={t("share.maxDownloads")}
          description={t("share.limitHint")}
          type="number"
          min={1}
          value={maxDownloads}
          onChange={(e) => setMaxDownloads(e.target.value)}
          placeholder="∞"
        />
      )}
      {upload && <p className="m-0 text-xs text-pretty text-kumo-subtle">{t("share.inboxHint")}</p>}
    </FormDialog>
  );
}
