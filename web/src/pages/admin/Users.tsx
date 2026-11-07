import { useEffect, useState } from "react";
import { Badge, Button, DropdownMenu, Input, LayerCard, Meter, Radio, Table } from "@cloudflare/kumo";
import {
  CrownIcon,
  DotsThreeIcon,
  HardDrivesIcon,
  ProhibitIcon,
  ShieldSlashIcon,
  TrashIcon,
  UserIcon,
  CheckCircleIcon,
} from "@phosphor-icons/react";
import { api, type AdminUser } from "@/api";
import { useI18n } from "@/i18n";
import { useAsync, useDebounced } from "@/lib/hooks";
import { useUser } from "@/lib/session";
import { GiB, displayName, formatBytes, formatRelative } from "@/lib/format";
import { toast } from "@/lib/toast";
import { ErrorState, Loading, Page } from "@/components/Page";
import { DeleteResourceDialog, FormDialog } from "@/components/Dialogs";
import { MfaBanner } from "@/components/MfaBanner";
import { SearchInput } from "@/components/SearchInput";
import { Pager } from "@/components/Pager";

const PER_PAGE = 50;

export function quotaLabel(bytes: number, unlimited: string) {
  return bytes < 0 ? unlimited : formatBytes(bytes);
}

export function UsersPage() {
  const { t, lang, errMsg } = useI18n();
  const me = useUser();
  const [q, setQ] = useState("");
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  const users = useAsync(
    () => api.admin.users({ q: dq || undefined, limit: PER_PAGE, offset: (page - 1) * PER_PAGE }),
    [dq, page],
  );
  const settings = useAsync(() => api.admin.settings(), []);
  const [quotaFor, setQuotaFor] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);

  useEffect(() => setPage(1), [dq]);

  const update = async (u: AdminUser, body: Parameters<typeof api.admin.updateUser>[1]) => {
    try {
      await api.admin.updateUser(u.id, body);
      toast.success(t("users.updated"));
      users.reload();
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const defaultQuota = settings.data?.site.default_quota_bytes ?? -1;

  return (
    <Page title={t("users.title")} description={t("users.subtitle")}>
      <MfaBanner />
      <SearchInput value={q} onChange={setQ} placeholder={t("users.search")} />
      {users.error != null && <ErrorState error={users.error} onRetry={users.reload} />}
      {users.loading && !users.data ? (
        <Loading />
      ) : (
        <LayerCard className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <Table.Header>
                <Table.Row>
                  <Table.Head>{t("nav.users")}</Table.Head>
                  <Table.Head>{t("common.role")}</Table.Head>
                  <Table.Head className="min-w-48">{t("users.usage")}</Table.Head>
                  <Table.Head className="hidden text-right md:table-cell">{t("users.projects")}</Table.Head>
                  <Table.Head className="hidden lg:table-cell">{t("users.lastLogin")}</Table.Head>
                  <Table.Head className="w-12" />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {(users.data?.users ?? []).map((u) => (
                  <Table.Row key={u.id}>
                    <Table.Cell>
                      <div className="flex items-center gap-2 font-medium">
                        {displayName(u)}
                        {u.id === me.id && <span className="text-kumo-subtle">({t("common.you")})</span>}
                      </div>
                      <div className="text-xs text-kumo-subtle">{u.email ?? u.username}</div>
                    </Table.Cell>
                    <Table.Cell>
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={u.role === "admin" ? "orange" : "neutral"}>{t(`role.${u.role}`)}</Badge>
                        {u.status === "disabled" && <Badge variant="red">{t("users.disabledBadge")}</Badge>}
                        {u.totp_enabled && <Badge variant="green">2FA</Badge>}
                        {u.oidc_linked && <Badge variant="blue">SSO</Badge>}
                      </div>
                    </Table.Cell>
                    <Table.Cell>
                      <Meter
                        label={formatBytes(u.used_bytes)}
                        value={u.quota_bytes > 0 ? Math.min(100, (u.used_bytes / u.quota_bytes) * 100) : 0}
                        customValue={
                          quotaLabel(u.quota_bytes, t("common.unlimited")) +
                          (u.quota_override == null ? ` (${t("common.default")})` : "")
                        }
                      />
                    </Table.Cell>
                    <Table.Cell className="hidden text-right tabular-nums md:table-cell">{u.project_count}</Table.Cell>
                    <Table.Cell className="hidden text-kumo-subtle lg:table-cell">
                      {formatRelative(u.last_login_at, lang)}
                    </Table.Cell>
                    <Table.Cell className="text-right">
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          render={
                            <Button
                              variant="ghost"
                              size="sm"
                              shape="square"
                              icon={DotsThreeIcon}
                              aria-label={t("common.actions")}
                            />
                          }
                        />
                        <DropdownMenu.Content align="end">
                          <DropdownMenu.Item icon={HardDrivesIcon} onClick={() => setQuotaFor(u)}>
                            {t("users.editQuota")}
                          </DropdownMenu.Item>
                          {u.id !== me.id && (
                            <>
                              <DropdownMenu.Item
                                icon={u.role === "admin" ? UserIcon : CrownIcon}
                                onClick={() => update(u, { role: u.role === "admin" ? "user" : "admin" })}
                              >
                                {u.role === "admin" ? t("users.makeUser") : t("users.makeAdmin")}
                              </DropdownMenu.Item>
                              <DropdownMenu.Item
                                icon={u.status === "active" ? ProhibitIcon : CheckCircleIcon}
                                onClick={() => update(u, { status: u.status === "active" ? "disabled" : "active" })}
                              >
                                {u.status === "active" ? t("users.disable") : t("users.enable")}
                              </DropdownMenu.Item>
                            </>
                          )}
                          {u.totp_enabled && (
                            <DropdownMenu.Item
                              icon={ShieldSlashIcon}
                              onClick={async () => {
                                try {
                                  await api.admin.resetMfa(u.id);
                                  toast.success(t("users.resetMfaDone"));
                                  users.reload();
                                } catch (e) {
                                  toast.error(errMsg(e));
                                }
                              }}
                            >
                              {t("users.resetMfa")}
                            </DropdownMenu.Item>
                          )}
                          {u.id !== me.id && (
                            <>
                              <DropdownMenu.Separator />
                              <DropdownMenu.Item icon={TrashIcon} variant="danger" onClick={() => setDeleting(u)}>
                                {t("common.delete")}
                              </DropdownMenu.Item>
                            </>
                          )}
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table>
          </div>
        </LayerCard>
      )}
      <Pager page={page} setPage={setPage} perPage={PER_PAGE} total={users.data?.total ?? 0} />

      <QuotaDialog
        user={quotaFor}
        defaultQuota={defaultQuota}
        onClose={() => setQuotaFor(null)}
        onSaved={() => {
          toast.success(t("users.updated"));
          users.reload();
        }}
      />
      <DeleteResourceDialog
        open={deleting != null}
        onOpenChange={(o) => !o && setDeleting(null)}
        resourceName={deleting?.username ?? ""}
        resourceType={t("deleteResource.type.user")}
        description={t("users.deleteDesc")}
        onDelete={async () => {
          await api.admin.deleteUser(deleting!.id);
          toast.success(t("users.deleted"));
          users.reload();
        }}
      />
    </Page>
  );
}

type QuotaMode = "default" | "unlimited" | "custom";

function QuotaDialog({
  user,
  defaultQuota,
  onClose,
  onSaved,
}: {
  user: AdminUser | null;
  defaultQuota: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [mode, setMode] = useState<QuotaMode>("default");
  const [gib, setGib] = useState("10");

  useEffect(() => {
    if (!user) return;
    const o = user.quota_override;
    setMode(o == null ? "default" : o < 0 ? "unlimited" : "custom");
    setGib(o != null && o > 0 ? String(+(o / GiB).toFixed(2)) : "10");
  }, [user]);

  const gibNum = Number(gib);
  const valid = mode !== "custom" || (Number.isFinite(gibNum) && gibNum > 0);

  return (
    <FormDialog
      open={user != null}
      onOpenChange={(o) => !o && onClose()}
      title={t("users.quotaTitle", { name: user ? displayName(user) : "" })}
      submitDisabled={!valid}
      onSubmit={async () => {
        const quota_bytes = mode === "default" ? null : mode === "unlimited" ? -1 : Math.round(gibNum * GiB);
        await api.admin.updateUser(user!.id, { quota_bytes });
        onClose();
        onSaved();
      }}
    >
      <Radio.Group legend={t("users.quota")} value={mode} onValueChange={(v) => setMode(v as QuotaMode)}>
        <Radio.Item
          value="default"
          label={t("users.quotaDefault", { value: quotaLabel(defaultQuota, t("common.unlimited")) })}
        />
        <Radio.Item value="unlimited" label={t("users.quotaUnlimited")} />
        <Radio.Item value="custom" label={t("users.quotaCustom")} />
      </Radio.Group>
      {mode === "custom" && (
        <div className="flex flex-col gap-2">
          <Input
            label={t("users.quotaGiB")}
            type="number"
            min={0.01}
            step="any"
            value={gib}
            onChange={(e) => setGib(e.target.value)}
          />
          <div className="flex flex-wrap gap-1.5">
            {[1, 5, 10, 50, 100, 500, 1024].map((n) => (
              <Button key={n} type="button" size="xs" variant="secondary" onClick={() => setGib(String(n))}>
                {n >= 1024 ? `${n / 1024} TB` : `${n} GB`}
              </Button>
            ))}
          </div>
        </div>
      )}
      {user && (
        <p className="m-0 text-sm text-kumo-subtle">
          {t("users.usage")}: {formatBytes(user.used_bytes)}
        </p>
      )}
    </FormDialog>
  );
}
