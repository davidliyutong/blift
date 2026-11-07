// Usage counters for the admin dashboard. Each API request accumulates its counters in
// c.var.stats and the middleware flushes them with ONE upsert after the response
// (waitUntil), so stats never add latency and cost exactly one D1 write per request.
import { stmt, type DB } from "../db";
import type { Ctx, StatDelta } from "../env";

export const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export function addStats(c: Ctx, delta: StatDelta) {
  const s = c.get("stats");
  for (const [k, v] of Object.entries(delta) as [keyof StatDelta, number][]) s[k] = (s[k] ?? 0) + v;
}

export function flushStats(db: DB, userId: string, s: StatDelta) {
  return stmt(
    db,
    `INSERT INTO stats_daily (day, user_id, requests, upload_bytes, download_bytes, uploads, downloads)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, user_id) DO UPDATE SET
       requests = requests + excluded.requests,
       upload_bytes = upload_bytes + excluded.upload_bytes,
       download_bytes = download_bytes + excluded.download_bytes,
       uploads = uploads + excluded.uploads,
       downloads = downloads + excluded.downloads`,
    day(),
    userId,
    s.requests ?? 0,
    s.upload_bytes ?? 0,
    s.download_bytes ?? 0,
    s.uploads ?? 0,
    s.downloads ?? 0,
  ).run();
}
