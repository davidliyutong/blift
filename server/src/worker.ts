// Cloudflare Workers entry. Static assets (the SPA) are served by Workers Assets before the
// Worker runs (see wrangler.toml `run_worker_first`), so only /api/* and /install.sh reach this code.
import type { ExecutionContext } from "hono";
import { createApp, resolveAlias } from "./app";
import { ensureMigrated } from "./db/migrations";
import type { Bindings } from "./env";
import { isReconcileTime, runGc } from "./services/gc";

const app = createApp();

export default {
  fetch: (req: Request, env: Bindings, ctx: ExecutionContext) => app.fetch(resolveAlias(req), env, ctx),
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
