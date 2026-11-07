import { useNavigate, useParams } from "react-router";
import { Tabs } from "@cloudflare/kumo";
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

  return (
    <Page
      title={
        <span className="flex items-center gap-3">
          {p.name}
          <RoleBadge role={p.role} />
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
      {tab === "files" && <FilesTab project={p} onChanged={project.reload} />}
      {tab === "shares" && <ProjectSharesTab project={p} />}
      {tab === "members" && <MembersTab project={p} />}
      {tab === "settings" && <SettingsTab project={p} onUpdated={project.reload} />}
    </Page>
  );
}
