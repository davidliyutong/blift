import { useNavigate, useParams } from "react-router";
import { Badge, Banner, Empty, Tabs } from "@cloudflare/kumo";
import { CloudSlashIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { api } from "@/api";
import { useI18n } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { ErrorState, Loading, Page } from "@/components/Page";
import { RoleBadge } from "@/pages/Projects";
import { FilesTab } from "./FilesTab";
import { ProjectSharesTab } from "./SharesTab";
import { MembersTab } from "./MembersTab";
import { SettingsTab } from "./SettingsTab";

const TABS = ["files", "shares", "members", "settings"] as const;
type Tab = (typeof TABS)[number];

export function ProjectPage() {
  const { t } = useI18n();
  const { id = "", tab: tabParam } = useParams();
  const navigate = useNavigate();
  const tab: Tab = TABS.includes(tabParam as Tab) ? (tabParam as Tab) : "files";
  const project = useAsync(() => api.projects.get(id), [id]);

  if (project.loading && !project.data) return <Loading className="py-32" />;
  if (!project.data) {
    return (
      <Page title={t("project.notFound")} crumbs={[{ label: t("nav.projects"), href: "/projects" }]}>
        <ErrorState error={project.error} onRetry={project.reload} />
      </Page>
    );
  }
  const p = project.data;
  // Only the project itself (and deleting it) works while its backend is disabled; the settings
  // tab still shows the details, everything else would answer storage_disabled.
  const unavailable = p.storage_status === "disabled";

  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          {p.name}
          <RoleBadge role={p.role} />
          {unavailable && <Badge variant="orange">{t("project.storageDisabled")}</Badge>}
        </span>
      }
      docTitle={p.name}
      description={p.description || undefined}
      crumbs={[{ label: t("nav.projects"), href: "/projects" }, { label: p.name }]}
    >
      <div className="-mt-2 border-b border-kumo-line">
        <Tabs
          variant="underline"
          value={tab}
          onValueChange={(v) => navigate(`/projects/${p.id}${v === "files" ? "" : `/${v}`}`)}
          tabs={TABS.map((v) => ({ value: v, label: t(`project.tab.${v}`) }))}
        />
      </div>
      {unavailable && tab !== "settings" ? (
        <Empty
          icon={<CloudSlashIcon size={48} weight="duotone" />}
          title={t("project.unavailableTitle")}
          description={t("project.unavailableDesc", { name: p.storage_name })}
        />
      ) : (
        <>
          {tab === "files" && <FilesTab project={p} onChanged={project.reload} />}
          {tab === "shares" && <ProjectSharesTab project={p} />}
          {tab === "members" && <MembersTab project={p} />}
          {unavailable && (
            <Banner
              variant="alert"
              icon={<WarningCircleIcon weight="fill" />}
              title={t("project.unavailableTitle")}
              description={t("project.unavailableDesc", { name: p.storage_name })}
            />
          )}
          {tab === "settings" && <SettingsTab project={p} onUpdated={project.reload} />}
        </>
      )}
    </Page>
  );
}
