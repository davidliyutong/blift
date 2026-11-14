import { forwardRef, type ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { LinkProvider, type LinkComponentProps } from "@cloudflare/kumo";

/** Routes Kumo links through react-router, except API/download and absolute URLs. */
const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, to, ...rest }, ref) => {
  // `to` is deprecated, but Kumo's own Breadcrumbs.Link still passes its target that way only:
  // without the fallback a breadcrumb rendered href="" and reloaded the current page.
  const target = href ?? to ?? "";
  if (!target.startsWith("/") || target.startsWith("/api/")) {
    return <a ref={ref} href={target} {...rest} />;
  }
  return <RouterLink ref={ref} to={target} {...rest} />;
});
AppLink.displayName = "AppLink";

export function AppLinkProvider({ children }: { children: ReactNode }) {
  return <LinkProvider component={AppLink}>{children}</LinkProvider>;
}
