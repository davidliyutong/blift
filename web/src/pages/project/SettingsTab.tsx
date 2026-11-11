import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Button, ClipboardText, Input, InlineCopyText, Switch } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, TrashIcon } from "@phosphor-icons/react";
import { api, type Project } from "@/api";
import { useI18n } from "@/i18n";
import { useSession } from "@/lib/session";
import { displayName, formatBytes, formatDate } from "@/lib/format";
import { toast } from "@/lib/toast";
import { Detail, Section } from "@/components/Page";
import { ConfirmDialog, DeleteResourceDialog } from "@/components/Dialogs";

export function SettingsTab({ project, onUpdated }: { project: Project; onUpdated: () => void }) {
  const { t, lang, errMsg } = useI18n();
  const { user } = useSession();
  const navigate = useNavigate();
  const isOwner = project.role === "owner";
  const canDelete = isOwner || user?.role === "admin";
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setName(project.name);
    setDescription(project.description);
  }, [project]);

  const valid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
  const dirty = name !== project.name || description !== project.description;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.projects.update(project.id, { name, description });
      toast.success(t("psettings.saved"));
      onUpdated();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Section title={t("psettings.general")}>
        <div className="flex flex-col gap-5">
          {isOwner && (
            <form className="flex flex-col gap-4" onSubmit={save}>
              <Input
                label={t("common.name")}
                description={t("projects.nameHint")}
                value={name}
                onChange={(e) => setName(e.target.value)}
                variant={valid ? "default" : "error"}
              />
              <Input
                label={t("common.description")}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required={false}
              />
              <div>
                <Button type="submit" variant="primary" loading={saving} disabled={!dirty || !valid}>
                  {t("common.save")}
                </Button>
              </div>
            </form>
          )}
          <div className="flex flex-col gap-3 border-t border-kumo-hairline pt-5 first:border-0 first:pt-0">
            <Detail label={t("psettings.id")}>
              <InlineCopyText>{project.id}</InlineCopyText>
            </Detail>
            <Detail label={t("common.owner")}>{displayName(project.owner)}</Detail>
            <Detail label={t("psettings.storage")}>
              {project.storage_location ? `${project.storage_name} · ${project.storage_location}` : project.storage_name}
            </Detail>
            <Detail label={t("projects.usage")}>
              {formatBytes(project.used_bytes)} · {t("common.items", { n: project.blob_count })}
            </Detail>
            <Detail label={t("common.created")}>{formatDate(project.created_at, lang)}</Detail>
          </div>
        </div>
      </Section>

      {(isOwner || project.inbox_enabled) && <InboxSection project={project} onUpdated={onUpdated} />}

      {canDelete && (
        <Section title={t("psettings.danger")} danger>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="max-w-lg">
              <div className="font-medium">{t("psettings.deleteTitle")}</div>
              <p className="m-0 mt-1 text-sm text-kumo-subtle">{t("psettings.deleteDesc")}</p>
            </div>
            <Button variant="destructive" icon={TrashIcon} onClick={() => setDeleting(true)}>
              {t("psettings.deleteButton")}
            </Button>
          </div>
        </Section>
      )}

      <DeleteResourceDialog
        open={deleting}
        onOpenChange={setDeleting}
        resourceName={project.name}
        resourceType={t("deleteResource.type.project")}
        onDelete={async () => {
          await api.projects.remove(project.id);
          toast.success(t("psettings.deleted"));
          navigate("/projects");
        }}
      />
    </div>
  );
}

/** Anonymous uploads: owners switch the inbox on and off; editors see the link. */
function InboxSection({ project, onUpdated }: { project: Project; onUpdated: () => void }) {
  const { t, errMsg } = useI18n();
  const isOwner = project.role === "owner";
  const [busy, setBusy] = useState(false);
  const [resetting, setResetting] = useState(false);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      await api.projects.update(project.id, { inbox_enabled: on });
      toast.success(t(on ? "inbox.enabled" : "inbox.disabled"));
      onUpdated();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t("inbox.title")} description={t("inbox.desc")}>
      <div className="flex flex-col gap-4">
        {isOwner ? (
          <Switch label={t("inbox.enable")} checked={project.inbox_enabled} disabled={busy} onCheckedChange={toggle} />
        ) : (
          <p className="m-0 text-sm">{t("inbox.onForMembers")}</p>
        )}
        {project.inbox_url && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">{t("inbox.link")}</span>
            <div className="flex flex-wrap items-center gap-2">
              <ClipboardText text={project.inbox_url} size="base" className="min-w-0 flex-1" />
              {isOwner && (
                <Button variant="secondary" icon={ArrowsClockwiseIcon} onClick={() => setResetting(true)}>
                  {t("inbox.reset")}
                </Button>
              )}
            </div>
          </div>
        )}
        <p className="m-0 text-xs text-pretty text-kumo-subtle">{t("inbox.hint")}</p>
      </div>

      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title={t("inbox.resetTitle")}
        description={t("inbox.resetDesc")}
        confirmLabel={t("inbox.reset")}
        onConfirm={async () => {
          await api.projects.resetInbox(project.id);
          toast.success(t("inbox.resetDone"));
          onUpdated();
        }}
      />
    </Section>
  );
}
