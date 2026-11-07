import type { ReactNode } from "react";
import { cn } from "@cloudflare/kumo";
import { useSession } from "@/lib/session";
import { useDocumentTitle } from "@/lib/hooks";
import { BrandMark } from "./Brand";
import { LanguageMenu, ThemeMenu } from "./Preferences";

/** Full-page centered card used by setup, login, CLI approval and public share pages. */
export function CenteredLayout({
  title,
  children,
  width = "max-w-[440px]",
  footer,
}: {
  title?: string;
  children: ReactNode;
  width?: string;
  footer?: ReactNode;
}) {
  const { info } = useSession();
  useDocumentTitle(title, info.name);
  return (
    <div className="flex min-h-full flex-col bg-kumo-canvas">
      <header className="flex h-[58px] shrink-0 items-center gap-2 px-4 md:px-6">
        <div className="flex flex-1 items-center gap-2.5">
          <BrandMark />
          <span className="text-base font-semibold text-kumo-strong">{info.name}</span>
        </div>
        <LanguageMenu />
        <ThemeMenu />
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[6vh] pb-16 md:pt-[10vh]">
        <div className={cn("w-full", width)}>{children}</div>
      </main>
      {footer && <footer className="pb-6 text-center text-xs text-kumo-subtle">{footer}</footer>}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-xl bg-kumo-base p-6 shadow-sm ring ring-kumo-line md:p-8", className)}>{children}</div>;
}

export function CardHeader({ title, subtitle, icon }: { title: ReactNode; subtitle?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-2">
      {icon && <div className="mb-1 text-kumo-brand">{icon}</div>}
      <h1 className="font-heading m-0 text-xl font-semibold text-kumo-default">{title}</h1>
      {subtitle && <p className="m-0 text-sm text-pretty text-kumo-subtle">{subtitle}</p>}
    </div>
  );
}
