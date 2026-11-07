import { forwardRef, type ReactNode } from "react";
import { Link as RouterLink } from "react-router";
import { LinkProvider, type LinkComponentProps } from "@cloudflare/kumo";

/** Routes Kumo links through react-router, except API/download and absolute URLs. */
const AppLink = forwardRef<HTMLAnchorElement, LinkComponentProps>(({ href, to: _to, ...rest }, ref) => {
  const target = href ?? "";
  if (!target.startsWith("/") || target.startsWith("/api/")) {
    return <a ref={ref} href={target} {...rest} />;
  }
  return <RouterLink ref={ref} to={target} {...rest} />;
});
AppLink.displayName = "AppLink";

export function AppLinkProvider({ children }: { children: ReactNode }) {
  return <LinkProvider component={AppLink}>{children}</LinkProvider>;
}
