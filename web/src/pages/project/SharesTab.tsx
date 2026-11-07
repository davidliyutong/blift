import { useState } from "react";
import { Button } from "@cloudflare/kumo";
import { ShareNetworkIcon } from "@phosphor-icons/react";
import { api, type Project } from "@/api";
import { useT } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { ErrorState, Loading } from "@/components/Page";
import { SharesTable } from "@/components/SharesTable";
import { ShareDialog } from "@/components/ShareDialog";

export function ProjectSharesTab({ project }: { project: Project }) {
  const t = useT();
  const shares = useAsync(() => api.shares.list(project.id).then((r) => r.shares), [project.id]);
  const [creating, setCreating] = useState(false);
  const canShare = project.role !== "viewer";
  const createButton = canShare && (
    <Button variant="primary" icon={ShareNetworkIcon} onClick={() => setCreating(true)}>
      {t("share.create")}
    </Button>
  );

  return (
    <div className="flex flex-col gap-4">
      {shares.data && shares.data.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <p className="m-0 text-sm text-kumo-subtle">{t("share.subtitle")}</p>
          {createButton}
        </div>
      )}
      {shares.error != null && <ErrorState error={shares.error} onRetry={shares.reload} />}
      {shares.loading && !shares.data ? (
        <Loading />
      ) : (
        shares.data && <SharesTable shares={shares.data} onDeleted={shares.reload} emptyAction={createButton} />
      )}
      <ShareDialog
        open={creating}
        onOpenChange={setCreating}
        project={project}
        onCreated={() => shares.reload()}
      />
    </div>
  );
}
