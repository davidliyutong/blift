// The whole HTTP API as one Hono app, shared by the Workers and Node entry points.
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authenticate } from "./auth";
import { ensureMigrated } from "./db/migrations";
import type { AppEnv } from "./env";
import { ApiError, notConfigured } from "./lib/errors";
import { wantsPage } from "./lib/http";
import admin from "./routes/admin";
import auth from "./routes/auth";
import { blobs, projectBlobs, projectDirs, projectStat } from "./routes/blobs";
import cli from "./routes/cli";
import meta from "./routes/meta";
import oidc from "./routes/oidc";
import projects from "./routes/projects";
import { publicShares, shares } from "./routes/shares";
import { projectUploads, uploads } from "./routes/uploads";
import { flushStats } from "./services/stats";

/**
 * Paths outside /api that the API answers, and the /api routes they are rewritten onto.
 * wrangler.toml `run_worker_first` lists them too, and node.ts sends them to the API.
 */
const ALIASES: [RegExp, string][] = [
  [/^\/install\.sh$/, "/api/cli/install.sh"],
  // Share links: direct downloads for wget and curl. Browsers get the web page (isSharePage).
  [/^\/s\/([^/]+)((?:\/[^/]+)*)\/?$/, "/api/public/shares/$1/direct$2"],
];

/** Rewrites a top-level alias such as /install.sh onto its /api route. */
export function resolveAlias(req: Request): Request {
  const url = new URL(req.url);
  const alias = ALIASES.find(([from]) => from.test(url.pathname));
  if (!alias) return req;
  url.pathname = url.pathname.replace(...alias);
  // Aliases are GET routes, so method and headers are all that is carried over. (Copying the
  // request with `new Request(url, req)` throws on Node 26 with @hono/node-server's requests.)
  return new Request(url, { method: req.method, headers: req.headers });
}

/**
 * A browser opening a share link (/s/<token>): it gets the web app, as for any other page, and
 * the entry points hand it over before the API runs, so page loads never touch the database.
 * wget and curl get the file instead (the alias above); /s/<token>/<path> is always a download.
 */
export function isSharePage(req: Request): boolean {
  return (req.method === "GET" || req.method === "HEAD") && /^\/s\/[^/]+\/?$/.test(new URL(req.url).pathname) && wantsPage(req);
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
  app.route("/projects/:pid/dirs", projectDirs);
  app.route("/projects/:pid/stat", projectStat);
  app.route("/projects/:pid/uploads", projectUploads);
  app.route("/blobs", blobs);
  app.route("/uploads", uploads);
  app.route("/shares", shares);
  app.route("/public/shares", publicShares);
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
