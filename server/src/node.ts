// Node entry for Docker / self-hosting: node:sqlite instead of D1, static files served
// from WEB_DIR, GC on a timer instead of a cron trigger.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp, isSharePage, resolveAlias } from "./app";
import { migrate } from "./db/migrations";
import { NodeD1 } from "./db/node-sqlite";
import type { Bindings } from "./env";
import { randomString } from "./lib/ids";
import { hasAdmin } from "./routes/meta";
import { isReconcileTime, runGc } from "./services/gc";
import { VERSION } from "./version";

const DATA_DIR = resolve(process.env.DATA_DIR ?? "./data");
const WEB_DIR = resolve(process.env.WEB_DIR ?? "../web/dist");
const PORT = Number(process.env.PORT ?? 8080);

mkdirSync(DATA_DIR, { recursive: true });

/** Reads a secret from env, else from DATA_DIR/<file>, else generates and persists one. */
function secret(envName: string, file: string, generate: () => string): { value: string; generated: boolean } {
  const fromEnv = process.env[envName];
  if (fromEnv) return { value: fromEnv, generated: false };
  const path = join(DATA_DIR, file);
  if (existsSync(path)) return { value: readFileSync(path, "utf8").trim(), generated: false };
  const value = generate();
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  return { value, generated: true };
}

const db = new NodeD1(process.env.DATABASE_PATH ?? join(DATA_DIR, "blift.db"));
await migrate(db);

const env: Bindings = {
  DB: db,
  APP_SECRET: secret("APP_SECRET", "app-secret", () => randomString(48)).value,
  PUBLIC_URL: process.env.PUBLIC_URL,
  GC_BUDGET: process.env.GC_BUDGET ?? "1000",
  GC_ROWS: process.env.GC_ROWS ?? "20000",
};

if (!(await hasAdmin(db))) {
  const s = secret("BOOTSTRAP_SECRET", "bootstrap-secret", () => randomString(24));
  env.BOOTSTRAP_SECRET = s.value;
  const where = process.env.BOOTSTRAP_SECRET ? "from $BOOTSTRAP_SECRET" : `stored in ${join(DATA_DIR, "bootstrap-secret")}`;
  console.log(`\n  No admin yet. Open /setup and use the bootstrap secret (${where}):\n\n      ${s.value}\n`);
} else {
  env.BOOTSTRAP_SECRET = process.env.BOOTSTRAP_SECRET;
}

const ctx = {
  waitUntil: (p: Promise<unknown>) => void p.catch((e) => console.error("background task:", e)),
  passThroughOnException() {},
  props: {},
};
const api = createApp();

const root = new Hono();
const toApi = (c: Context) => api.fetch(resolveAlias(c.req.raw), env, ctx as never);
root.all("/api/*", toApi);
root.get("/install.sh", toApi);
root.all("/dav", toApi);
root.all("/dav/*", toApi);
// Share links: browsers get the page (static files and SPA fallback below), wget and curl the file.
root.get("/s/*", (c, next) => (isSharePage(c.req.raw) ? next() : toApi(c)));
root.use(
  "/assets/*",
  serveStatic({ root: WEB_DIR, onFound: (_p, c) => c.header("cache-control", "public, max-age=31536000, immutable") }),
);
root.use("*", serveStatic({ root: WEB_DIR }));
// SPA fallback: every other path renders the app shell.
root.get("*", serveStatic({ path: join(WEB_DIR, "index.html"), onFound: (_p, c) => c.header("cache-control", "no-cache") }));

const server = serve({ fetch: root.fetch, port: PORT, hostname: process.env.HOST ?? "0.0.0.0" }, (info) =>
  console.log(`blift ${VERSION} listening on http://${info.address}:${info.port} (data: ${DATA_DIR}, web: ${WEB_DIR})`),
);

// GC every 15 minutes (first run shortly after start).
const gc = async () => {
  try {
    const r = await runGc(env, { reconcile: isReconcileTime() });
    if (r.stale_uploads || r.objects_deleted || r.projects_purged || r.errors) console.log("gc:", JSON.stringify(r));
  } catch (e) {
    console.error("gc failed:", e);
  }
};
setTimeout(gc, 30_000).unref();
setInterval(gc, 15 * 60_000).unref();

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
