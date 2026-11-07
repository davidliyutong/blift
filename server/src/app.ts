// The whole HTTP API as one Hono app, shared by the Workers and Node entry points.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authenticate } from "./auth";
import { ensureMigrated } from "./db/migrations";
import type { AppEnv } from "./env";
import { ApiError, notConfigured } from "./lib/errors";
import admin from "./routes/admin";
import auth from "./routes/auth";
import { blobs, projectBlobs } from "./routes/blobs";
import cli from "./routes/cli";
import { inbox } from "./routes/inbox";
import meta from "./routes/meta";
import oidc from "./routes/oidc";
import projects from "./routes/projects";
import { publicShares, shares } from "./routes/shares";
import { projectUploads, uploads } from "./routes/uploads";
import { flushStats } from "./services/stats";

/** Paths outside /api that the API answers; wrangler.toml `run_worker_first` lists them too. */
const ALIASES: Record<string, string> = { "/install.sh": "/api/cli/install.sh" };

/** Rewrites a top-level alias such as /install.sh onto its /api route. */
export function resolveAlias(req: Request): Request {
  const url = new URL(req.url);
  const to = ALIASES[url.pathname];
  if (!to) return req;
  url.pathname = to;
  return new Request(url, req);
}

export function createApp() {
  const app = new Hono<AppEnv>().basePath("/api");

  app.use("*", async (c, next) => {
    if (!c.env.APP_SECRET) throw notConfigured("APP_SECRET is not set on the server");
    await ensureMigrated(c.env.DB);
    c.set("stats", { requests: 1 });
    await next();
    const userId = c.get("statsUser") ?? c.get("user")?.id ?? "";
    c.executionCtx.waitUntil(flushStats(c.env.DB, userId, c.get("stats")).catch((e) => console.error("stats:", e)));
  });
  app.use("*", authenticate);
  // API responses are per-user; never let a proxy cache them.
  app.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.header("cache-control", "no-store");
  });

  app.route("/", meta);
  app.route("/auth", auth);
  app.route("/auth/oidc", oidc);
  app.route("/cli", cli);
  app.route("/projects", projects);
  app.route("/projects/:pid/blobs", projectBlobs);
  app.route("/projects/:pid/uploads", projectUploads);
  app.route("/blobs", blobs);
  app.route("/uploads", uploads);
  app.route("/shares", shares);
  app.route("/public/shares", publicShares);
  app.route("/public/inbox", inbox);
  app.route("/admin", admin);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "route not found" } }, 404));
  app.onError((err, c) => {
    if (err instanceof ApiError)
      return c.json({ error: { code: err.code, message: err.message } }, err.status as 400);
    if (err instanceof HTTPException)
      return c.json({ error: { code: err.status === 401 ? "unauthorized" : "bad_request", message: err.message } }, err.status);
    console.error(`${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: { code: "internal", message: "internal server error" } }, 500);
  });
  return app;
}
