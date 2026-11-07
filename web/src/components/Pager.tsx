import { Pagination } from "@cloudflare/kumo";
import { useT } from "@/i18n";

export function Pager({
  page,
  setPage,
  perPage,
  total,
}: {
  page: number;
  setPage: (p: number) => void;
  perPage: number;
  total: number;
}) {
  const t = useT();
  if (total <= perPage) return null;
  return (
    <Pagination
      page={page}
      setPage={setPage}
      perPage={perPage}
      totalCount={total}
      text={({ pageShowingRange }) => t("common.pageRange", { range: pageShowingRange, total })}
    />
  );
}
