import { api } from "@/api";
import { useT } from "@/i18n";
import { useAsync } from "@/lib/hooks";
import { ErrorState, Loading, Page } from "@/components/Page";
import { SharesTable } from "@/components/SharesTable";

export function SharesPage() {
  const t = useT();
  const shares = useAsync(() => api.shares.list().then((r) => r.shares), []);
  return (
    <Page title={t("share.title")} description={t("share.subtitle")}>
      {shares.error != null && <ErrorState error={shares.error} onRetry={shares.reload} />}
      {shares.loading && !shares.data ? (
        <Loading />
      ) : (
        shares.data && <SharesTable shares={shares.data} showProject onDeleted={shares.reload} />
      )}
    </Page>
  );
}
