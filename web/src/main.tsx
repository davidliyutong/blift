import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import { Toasty, Loader } from "@cloudflare/kumo";
import "./index.css";
import { I18nProvider } from "@/i18n";
import { ThemeProvider } from "@/lib/theme";
import { SessionProvider } from "@/lib/session";
import { toastManager } from "@/lib/toast";
import { reloadForNewVersion } from "@/lib/reload";
import { router } from "./router";

// A lazy page chunk from a previous deploy is gone: reload once to get the new build.
// If that already happened, let the error reach the router's error page instead.
window.addEventListener("vite:preloadError", (e) => {
  if (reloadForNewVersion()) e.preventDefault();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ThemeProvider>
        <Toasty toastManager={toastManager}>
          <SessionProvider
            fallback={
              <div className="flex h-full items-center justify-center text-kumo-subtle">
                <Loader size={24} />
              </div>
            }
          >
            <RouterProvider router={router} />
          </SessionProvider>
        </Toasty>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
