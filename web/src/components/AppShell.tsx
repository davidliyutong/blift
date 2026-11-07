import { Outlet, useLocation, useNavigate } from "react-router";
import { Button, DropdownMenu, Sidebar, useSidebar } from "@cloudflare/kumo";
import {
  ChartLineIcon,
  DatabaseIcon,
  FolderSimpleIcon,
  GearSixIcon,
  ListIcon,
  ShareNetworkIcon,
  SignOutIcon,
  UserCircleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { useT } from "@/i18n";
import { useSession, useUser } from "@/lib/session";
import { displayName } from "@/lib/format";
import { Brand } from "./Brand";
import { LanguageMenu, ThemeMenu } from "./Preferences";
import { UploadPanel } from "./UploadPanel";

export function AppShell() {
  const t = useT();
  const user = useUser();
  const { pathname } = useLocation();
  const is = (prefix: string, exact = false) => (exact ? pathname === prefix : pathname.startsWith(prefix));

  return (
    <Sidebar.Provider className="h-svh" defaultOpen>
      <Sidebar>
        <Sidebar.Header>
          <Brand />
        </Sidebar.Header>
        <Sidebar.Content>
          <Sidebar.Group>
            <Sidebar.Menu>
              <Sidebar.MenuButton
                href="/projects"
                icon={FolderSimpleIcon}
                tooltip={t("nav.projects")}
                active={is("/projects")}
              >
                {t("nav.projects")}
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                href="/shares"
                icon={ShareNetworkIcon}
                tooltip={t("nav.shares")}
                active={is("/shares")}
              >
                {t("nav.shares")}
              </Sidebar.MenuButton>
              <Sidebar.MenuButton
                href="/settings"
                icon={UserCircleIcon}
                tooltip={t("nav.account")}
                active={is("/settings")}
              >
                {t("nav.account")}
              </Sidebar.MenuButton>
            </Sidebar.Menu>
          </Sidebar.Group>
          {user.role === "admin" && (
            <Sidebar.Group>
              <Sidebar.GroupLabel>{t("nav.admin")}</Sidebar.GroupLabel>
              <Sidebar.Menu>
                <Sidebar.MenuButton
                  href="/admin"
                  icon={ChartLineIcon}
                  tooltip={t("nav.dashboard")}
                  active={is("/admin", true)}
                >
                  {t("nav.dashboard")}
                </Sidebar.MenuButton>
                <Sidebar.MenuButton
                  href="/admin/users"
                  icon={UsersThreeIcon}
                  tooltip={t("nav.users")}
                  active={is("/admin/users")}
                >
                  {t("nav.users")}
                </Sidebar.MenuButton>
                <Sidebar.MenuButton
                  href="/admin/storages"
                  icon={DatabaseIcon}
                  tooltip={t("nav.storages")}
                  active={is("/admin/storages")}
                >
                  {t("nav.storages")}
                </Sidebar.MenuButton>
                <Sidebar.MenuButton
                  href="/admin/settings"
                  icon={GearSixIcon}
                  tooltip={t("nav.settings")}
                  active={is("/admin/settings")}
                >
                  {t("nav.settings")}
                </Sidebar.MenuButton>
              </Sidebar.Menu>
            </Sidebar.Group>
          )}
        </Sidebar.Content>
        <Sidebar.Footer>
          <Sidebar.Trigger />
        </Sidebar.Footer>
      </Sidebar>

      <div className="flex min-w-0 flex-1 flex-col bg-kumo-canvas">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <UploadPanel />
    </Sidebar.Provider>
  );
}

function TopBar() {
  const t = useT();
  const { isMobile, toggleSidebar } = useSidebar();
  return (
    <header className="flex h-[58px] shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-base px-3 md:px-5">
      {isMobile && (
        <>
          <Button variant="ghost" shape="square" icon={ListIcon} aria-label={t("nav.toggleSidebar")} onClick={toggleSidebar} />
          <Brand compact />
        </>
      )}
      <div className="flex-1" />
      <LanguageMenu />
      <ThemeMenu />
      <UserMenu />
    </header>
  );
}

function UserMenu() {
  const t = useT();
  const user = useUser();
  const { logout } = useSession();
  const navigate = useNavigate();
  const name = displayName(user);
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            type="button"
            className="ml-1 flex size-8 cursor-pointer items-center justify-center rounded-full bg-kumo-contrast text-xs font-semibold text-kumo-inverse uppercase ring-kumo-line hover:ring-2"
            aria-label={name}
          >
            {name.slice(0, 1)}
          </button>
        }
      />
      <DropdownMenu.Content align="end">
        <div className="px-3 py-2">
          <div className="text-sm font-medium text-kumo-default">{name}</div>
          <div className="text-xs text-kumo-subtle">{user.email ?? user.username}</div>
        </div>
        <DropdownMenu.Separator />
        <DropdownMenu.Item icon={UserCircleIcon} onClick={() => navigate("/settings")}>
          {t("nav.account")}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          icon={SignOutIcon}
          onClick={async () => {
            await logout();
            navigate("/login");
          }}
        >
          {t("nav.logout")}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}
