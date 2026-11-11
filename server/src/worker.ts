// Cloudflare Workers entry. Static assets (the SPA) are served by Workers Assets before the
// Worker runs (see wrangler.toml `run_worker_first`), so only /api/*, /install.sh and share links
// (/s/*) reach this code. Browsers opening a share link are handed back to the assets at once.
import type { ExecutionContext } from "hono";
import { createApp, isSharePage, resolveAlias } from "./app";
import { ensureMigrated } from "./db/migrations";
import type { Bindings } from "./env";
import { isReconcileTime, runGc } from "./services/gc";

const app = createApp();

export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) =>
    env.ASSETS && isSharePage(req) ? env.ASSETS.fetch(req) : app.fetch(resolveAlias(req), env, ctx),
  async scheduled(_event: unknown, env: Bindings, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(
      (async () => {
        await ensureMigrated(env.DB);
        const result = await runGc(env, { reconcile: isReconcileTime() });
        console.log("gc:", JSON.stringify(result));
      })(),
    );
  },
};
