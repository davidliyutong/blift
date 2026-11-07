import { useEffect, useState } from "react";
import { Banner, Button, ClipboardText, Input, Select, Switch } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, KeyIcon } from "@phosphor-icons/react";
import { api, type Share } from "@/api";
import { useT } from "@/i18n";
import { randomPassword } from "@/lib/format";
import { FormDialog } from "./Dialogs";

const EXPIRY = { "1h": 3600, "1d": 86400, "7d": 7 * 86400, "30d": 30 * 86400, never: 0 } as const;
type ExpiryKey = keyof typeof EXPIRY;

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
  blob?: { id: string; name: string } | null;
  onCreated?: (s: Share) => void;
}) {
  const t = useT();
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<ExpiryKey>("7d");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [created, setCreated] = useState<{ share: Share; password: string } | null>(null);

  useEffect(() => {
    if (open) {
      setUsePassword(false);
      setPassword(randomPassword(8));
      setExpiry("7d");
      setMaxDownloads("");
      setCreated(null);
    }
  }, [open]);

  const target = blob?.name ?? project.name;

  if (created) {
    return (
      <FormDialog
        open={open}
        onOpenChange={onOpenChange}
        title={t("share.created")}
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

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("share.createFor", { name: target })}
      submitLabel={t("share.create")}
      submitDisabled={usePassword && password.length === 0}
      onSubmit={async () => {
        const share = await api.shares.create({
          project_id: project.id,
          blob_id: blob?.id,
          password: usePassword ? password : undefined,
          expires_in: EXPIRY[expiry] || null,
          max_downloads: maxDownloads ? Number(maxDownloads) : null,
        });
        setCreated({ share, password: usePassword ? password : "" });
        onCreated?.(share);
      }}
    >
      <div className="flex flex-col gap-1 rounded-lg bg-kumo-recessed px-4 py-3">
        <span className="text-xs text-kumo-subtle">{t("share.target")}</span>
        <span className="truncate font-medium">{blob ? blob.name : `${project.name} · ${t("share.wholeProject")}`}</span>
      </div>

      <Switch
        label={t("share.password")}
        checked={usePassword}
        onCheckedChange={setUsePassword}
      />
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
          <p className="m-0 text-xs text-kumo-subtle">{t("share.passwordHint")}</p>
        </div>
      )}

      <div className="grid items-start gap-4 sm:grid-cols-2">
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
        <Input
          label={t("share.maxDownloads")}
          description={t("share.maxDownloadsHint")}
          type="number"
          min={1}
          value={maxDownloads}
          onChange={(e) => setMaxDownloads(e.target.value)}
          placeholder="∞"
        />
      </div>
    </FormDialog>
  );
}
