import { Button, Empty } from "@cloudflare/kumo";
import { ArrowClockwiseIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { useT } from "@/i18n";
import { isChunkLoadError, reloading } from "@/lib/reload";

/** Root errorElement: replaces React Router's developer error screen. */
export function RouteError() {
  const t = useT();
  const error = useRouteError();
  if (reloading) return null;
  const stale = isChunkLoadError(error);
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error);
  if (!stale) console.error(error);
  return (
    <div className="flex min-h-full items-center justify-center bg-kumo-base p-4">
      <div className="w-full max-w-lg">
        <Empty
          icon={<WarningCircleIcon size={48} weight="duotone" />}
          title={stale ? t("app.updated") : t("app.errorTitle")}
          description={stale ? undefined : detail}
          contents={
            <Button variant="primary" icon={ArrowClockwiseIcon} onClick={() => location.reload()}>
              {t("common.refresh")}
            </Button>
          }
        />
      </div>
    </div>
  );
}
