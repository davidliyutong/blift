import { lazy, Suspense, type ReactNode } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation } from "react-router";
import { Loader } from "@cloudflare/kumo";
import { AppLinkProvider } from "@/components/AppLink";
import { AppShell } from "@/components/AppShell";
import { useSession } from "@/lib/session";
import { SetupPage } from "@/pages/Setup";
import { LoginPage } from "@/pages/Login";
import { ProjectsPage } from "@/pages/Projects";
import { ProjectPage } from "@/pages/project/ProjectPage";
import { SharesPage } from "@/pages/Shares";
import { AccountPage } from "@/pages/Account";
import { CliAuthorizePage } from "@/pages/CliAuthorize";
import { PublicSharePage } from "@/pages/PublicShare";
import { InboxPage } from "@/pages/Inbox";
import { NotFoundPage } from "@/pages/NotFound";
import { RouteError } from "@/pages/RouteError";

// Admin pages (and echarts) are only downloaded by administrators.
const DashboardPage = lazy(() => import("@/pages/admin/Dashboard"));
const UsersPage = lazy(() => import("@/pages/admin/Users").then((m) => ({ default: m.UsersPage })));
const StoragesPage = lazy(() => import("@/pages/admin/Storages").then((m) => ({ default: m.StoragesPage })));
const AdminSettingsPage = lazy(() =>
  import("@/pages/admin/AdminSettings").then((m) => ({ default: m.AdminSettingsPage })),
);

function Root() {
  const { info } = useSession();
  const { pathname } = useLocation();
  if (info.setup_required && pathname !== "/setup" && !pathname.startsWith("/s/") && !pathname.startsWith("/i/")) {
    return <Navigate to="/setup" replace />;
  }
  return (
    <AppLinkProvider>
      <Outlet />
    </AppLinkProvider>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, mfaPending } = useSession();
  const loc = useLocation();
  if (!user) {
    const redirect = encodeURIComponent(loc.pathname + loc.search);
    return <Navigate to={`/login?redirect=${redirect}${mfaPending ? "&mfa=1" : ""}`} replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useSession();
  if (user?.role !== "admin") return <Navigate to="/projects" replace />;
  return <>{children}</>;
}

const spinner = (
  <div className="flex h-64 items-center justify-center text-kumo-subtle">
    <Loader size={20} />
  </div>
);

export const router = createBrowserRouter([
  {
    element: <Root />,
    errorElement: <RouteError />,
    children: [
      { path: "/setup", element: <SetupPage /> },
      { path: "/login", element: <LoginPage /> },
      { path: "/s/:token", element: <PublicSharePage /> },
      { path: "/i/:token", element: <InboxPage /> },
      {
        path: "/cli",
        element: (
          <RequireAuth>
            <CliAuthorizePage />
          </RequireAuth>
        ),
      },
      {
        element: (
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        ),
        children: [
          { path: "/", element: <Navigate to="/projects" replace /> },
          { path: "/projects", element: <ProjectsPage /> },
          { path: "/projects/:id/:tab?", element: <ProjectPage /> },
          { path: "/shares", element: <SharesPage /> },
          { path: "/settings", element: <AccountPage /> },
          {
            path: "/admin",
            element: (
              <RequireAdmin>
                <Suspense fallback={spinner}>
                  <Outlet />
                </Suspense>
              </RequireAdmin>
            ),
            children: [
              { index: true, element: <DashboardPage /> },
              { path: "users", element: <UsersPage /> },
              { path: "storages", element: <StoragesPage /> },
              { path: "settings", element: <AdminSettingsPage /> },
            ],
          },
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
