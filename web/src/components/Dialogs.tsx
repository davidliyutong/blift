import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Banner, Button, Dialog, Input } from "@cloudflare/kumo";
import { WarningCircleIcon, XIcon } from "@phosphor-icons/react";
import { useI18n } from "@/i18n";
import { formValues } from "@/lib/form";

/**
 * Dialog chrome used across the app: header with title + close, body, footer actions.
 * `onSubmit` turns the body into a form; it receives the named fields (see lib/form.ts) and
 * errors thrown by it are shown inline.
 */
export function FormDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  submitLabel,
  submitVariant = "primary",
  submitDisabled,
  onSubmit,
  size = "lg",
  footer,
  extraActions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  submitLabel?: string;
  submitVariant?: "primary" | "destructive";
  submitDisabled?: boolean;
  onSubmit?: (values: Record<string, string>) => Promise<unknown> | void;
  size?: "sm" | "base" | "lg" | "xl";
  footer?: ReactNode;
  /** Rendered at the left side of the default footer (e.g. a "Test" button). */
  extraActions?: ReactNode;
}) {
  const { t, errMsg } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!onSubmit || busy) return;
    const values = formValues(e);
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <Dialog size={size} className="max-h-[90vh] overflow-y-auto p-0">
        <div className="flex items-center justify-between gap-4 border-b border-kumo-line px-6 py-4">
          <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
          <Dialog.Close
            render={(props) => (
              <Button {...props} variant="ghost" shape="square" size="sm" aria-label={t("common.close")}>
                <XIcon size={18} />
              </Button>
            )}
          />
        </div>
        <form onSubmit={submit}>
          <div className="flex flex-col gap-4 px-6 py-5">
            {description && <Dialog.Description className="m-0 text-kumo-subtle">{description}</Dialog.Description>}
            {error != null && (
              <Banner variant="error" icon={<WarningCircleIcon weight="fill" />} title={errMsg(error)} />
            )}
            {children}
          </div>
          {(onSubmit || footer) && (
            <div className="flex justify-end gap-2 border-t border-kumo-line px-6 py-4">
              {footer ?? (
                <>
                  {extraActions && <div className="mr-auto flex gap-2">{extraActions}</div>}
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button type="submit" variant={submitVariant} loading={busy} disabled={submitDisabled}>
                    {submitLabel ?? t("common.save")}
                  </Button>
                </>
              )}
            </div>
          )}
        </form>
      </Dialog>
    </Dialog.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = true,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => Promise<unknown> | void;
}) {
  const { t } = useI18n();
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="base"
      submitLabel={confirmLabel ?? t("common.delete")}
      submitVariant={destructive ? "destructive" : "primary"}
      onSubmit={async () => {
        await onConfirm();
        onOpenChange(false);
      }}
    />
  );
}

/** Cloudflare "type the name to confirm" deletion dialog (Kumo DeleteResource pattern, localized). */
export function DeleteResourceDialog({
  open,
  onOpenChange,
  resourceName,
  resourceType,
  description,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resourceName: string;
  resourceType: string;
  description?: ReactNode;
  onDelete: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  useEffect(() => {
    if (!open) setValue("");
  }, [open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("deleteResource.title", { name: resourceName })}
      size="base"
      submitLabel={t("deleteResource.button", { type: resourceType })}
      submitVariant="destructive"
      submitDisabled={value !== resourceName}
      onSubmit={async () => {
        await onDelete();
        onOpenChange(false);
      }}
    >
      <p className="m-0 text-pretty text-kumo-subtle">
        {t("deleteResource.body", { name: resourceName, type: resourceType })}
        {description && <> {description}</>}
      </p>
      <div className="flex flex-col gap-2">
        <span className="text-sm">
          {t("deleteResource.typeToConfirm")}
          <code className="ml-1 rounded-md bg-kumo-tint px-2 py-1 font-mono text-sm font-semibold">{resourceName}</code>
        </span>
        <Input
          aria-label={resourceName}
          placeholder={resourceName}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="w-full"
        />
      </div>
    </FormDialog>
  );
}
