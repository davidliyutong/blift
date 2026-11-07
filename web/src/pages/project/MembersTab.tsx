import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { Button, Input, LayerCard, Select, Table } from "@cloudflare/kumo";
import { SignOutIcon, TrashIcon, UserPlusIcon } from "@phosphor-icons/react";
import { api, type Member, type Project, type ProjectRole } from "@/api";
import { useI18n } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { useUser } from "@/lib/session";
import { displayName, formatRelative } from "@/lib/format";
import { toast } from "@/lib/toast";
import { ErrorState, Loading, Section } from "@/components/Page";
import { ConfirmDialog } from "@/components/Dialogs";
import { RoleBadge } from "@/pages/Projects";

export function MembersTab({ project }: { project: Project }) {
  const { t, lang, errMsg } = useI18n();
  const me = useUser();
  const navigate = useNavigate();
  const isOwner = project.role === "owner";
  const members = useAsync(() => api.projects.members(project.id).then((r) => r.members), [project.id]);
  const [who, setWho] = useState("");
  const [role, setRole] = useState<ProjectRole>("editor");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);

  const roleItems = { editor: t("role.editor"), viewer: t("role.viewer") };

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setAdding(true);
    try {
      await api.projects.addMember(project.id, who.trim(), role);
      toast.success(t("members.added"));
      setWho("");
      members.reload();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setAdding(false);
    }
  };

  const changeRole = async (m: Member, r: ProjectRole) => {
    try {
      await api.projects.setMemberRole(project.id, m.user.id, r);
      toast.success(t("members.updated"));
      members.reload();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {isOwner && (
        <Section title={t("members.add")} description={t("members.roleHelp")}>
          <form className="flex flex-col gap-2" onSubmit={add}>
            <div className="flex flex-wrap items-end gap-3">
              <Input
                className="w-72"
                label={t("members.user")}
                value={who}
                onChange={(e) => setWho(e.target.value)}
                placeholder="alice / alice@example.com"
                required
              />
              <Select
                label={t("common.role")}
                hideLabel={false}
                className="w-40"
                value={role}
                onValueChange={(v) => setRole(v as ProjectRole)}
                items={roleItems}
              />
              <Button type="submit" variant="primary" icon={UserPlusIcon} loading={adding}>
                {t("members.add")}
              </Button>
            </div>
            <p className="m-0 text-xs text-kumo-subtle">{t("members.userHint")}</p>
          </form>
        </Section>
      )}

      {members.error != null && <ErrorState error={members.error} onRetry={members.reload} />}
      {members.loading && !members.data ? (
        <Loading />
      ) : (
        <LayerCard className="p-0">
          <Table>
            <Table.Header>
              <Table.Row>
                <Table.Head>{t("nav.users")}</Table.Head>
                <Table.Head>{t("common.role")}</Table.Head>
                <Table.Head className="hidden md:table-cell">{t("common.created")}</Table.Head>
                <Table.Head className="w-16" />
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {(members.data ?? []).map((m) => {
                const self = m.user.id === me.id;
                return (
                  <Table.Row key={m.user.id}>
                    <Table.Cell>
                      <div className="font-medium">
                        {displayName(m.user)}
                        {self && <span className="ml-1.5 text-kumo-subtle">({t("common.you")})</span>}
                      </div>
                      <div className="text-xs text-kumo-subtle">{m.user.email ?? m.user.username}</div>
                    </Table.Cell>
                    <Table.Cell>
                      {isOwner && m.role !== "owner" ? (
                        <Select
                          aria-label={t("common.role")}
                          size="sm"
                          className="w-32"
                          value={m.role}
                          onValueChange={(v) => changeRole(m, v as ProjectRole)}
                          items={roleItems}
                        />
                      ) : (
                        <RoleBadge role={m.role} />
                      )}
                    </Table.Cell>
                    <Table.Cell className="hidden text-kumo-subtle md:table-cell">
                      {formatRelative(m.created_at, lang)}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      {m.role !== "owner" && (isOwner || self) && (
                        <Button
                          variant="ghost"
                          size="sm"
                          shape="square"
                          icon={self ? SignOutIcon : TrashIcon}
                          title={self ? t("members.leave") : t("common.remove")}
                          onClick={() => setRemoving(m)}
                        />
                      )}
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </LayerCard>
      )}

      <ConfirmDialog
        open={removing != null}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={
          removing?.user.id === me.id
            ? t("members.leave")
            : t("members.removeTitle", { name: displayName(removing?.user) })
        }
        description={t("members.removeDesc")}
        confirmLabel={removing?.user.id === me.id ? t("members.leave") : t("common.remove")}
        onConfirm={async () => {
          const leaving = removing!.user.id === me.id;
          await api.projects.removeMember(project.id, removing!.user.id);
          toast.success(t("members.removed"));
          if (leaving) navigate("/projects");
          else members.reload();
        }}
      />
    </div>
  );
}
