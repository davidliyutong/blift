import { Fragment, type ReactNode } from "react";
import { Banner, Breadcrumbs, Button, Loader, cn } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { useI18n } from "@/i18n";
import { useDocumentTitle } from "@/lib/hooks";
import { useSession } from "@/lib/session";

export interface Crumb {
  label: string;
  href?: string;
}

/** Standard page frame: breadcrumbs, title, description, actions and content. */
export function Page({
  title,
  description,
  crumbs,
  actions,
  children,
  className,
  wide = true,
  docTitle,
}: {
  title: ReactNode;
  /** Browser tab title when `title` is not a plain string. */
  docTitle?: string;
  description?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  wide?: boolean;
}) {
  const { info } = useSession();
  useDocumentTitle(docTitle ?? (typeof title === "string" ? title : undefined), info.name);
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col gap-6 p-5 md:p-8 lg:px-10 lg:py-9",
        wide ? "max-w-[1400px]" : "max-w-[960px]",
        className,
      )}
    >
      <div className="flex flex-col gap-3">
        {crumbs && crumbs.length > 0 && (
          <Breadcrumbs size="sm">
            {crumbs.map((c, i) => (
              <Fragment key={i}>
                {i > 0 && <Breadcrumbs.Separator />}
                {i === crumbs.length - 1 && !c.href ? (
                  <Breadcrumbs.Current>{c.label}</Breadcrumbs.Current>
                ) : (
                  <Breadcrumbs.Link href={c.href ?? "#"}>{c.label}</Breadcrumbs.Link>
                )}
              </Fragment>
            ))}
          </Breadcrumbs>
        )}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h1 className="font-heading m-0 truncate text-2xl font-semibold text-kumo-default md:text-3xl">{title}</h1>
            {description && <p className="m-0 max-w-prose text-base text-pretty text-kumo-subtle">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      </div>
      {children}
    </div>
  );
}

/** Card with a header row (title + optional actions) and body. Cloudflare-dashboard style. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  danger,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  danger?: boolean;
}) {
  return (
    <section
      className={cn(
        "overflow-hidden rounded-lg bg-kumo-base ring",
        danger ? "ring-kumo-danger/40" : "ring-kumo-line",
        className,
      )}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-kumo-hairline px-5 py-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            {title && (
              <h2 className={cn("m-0 text-base font-semibold", danger ? "text-kumo-danger" : "text-kumo-default")}>
                {title}
              </h2>
            )}
            {description && <p className="m-0 text-sm text-kumo-subtle">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function Loading({ className }: { className?: string }) {
  return (
    <div className={cn("flex items-center justify-center py-16 text-kumo-subtle", className)}>
      <Loader size={20} />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { t, errMsg } = useI18n();
  return (
    <Banner
      variant="error"
      icon={<WarningCircleIcon weight="fill" />}
      title={errMsg(error)}
      action={
        onRetry && (
          <Button size="sm" variant="secondary" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        )
      }
    />
  );
}

/** Small label/value row used in detail cards. */
export function Detail({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
      <div className="w-44 shrink-0 text-sm text-kumo-subtle">{label}</div>
      <div className="min-w-0 text-sm text-kumo-default">{children}</div>
    </div>
  );
}
