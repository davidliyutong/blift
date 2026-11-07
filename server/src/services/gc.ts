// Garbage collection. Runs from the Workers cron trigger (every 15 min) or a timer in Node,
// and on demand from the admin UI.
//
// Every S3 call is a subrequest; Workers on the free plan allow only 50 per invocation, so
// object deletion works through a bounded `budget` and simply continues on the next run.
// DeleteObjects removes up to 1000 keys per call, so even a small budget drains quickly.
import { all, chunks, now, placeholders, run, stmt, type Stmt } from "../db";
import type { Bindings } from "../env";
import { pool } from "../lib/http";
import { day } from "./stats";
import { getSettings } from "./settings";
import { storageFor } from "./storage";

export type GcOptions = {
  /** Max S3 requests for this run. */
  budget?: number;
  /** Recompute usage counters from the blobs table (heavier; daily is plenty). */
  reconcile?: boolean;
};

export async function runGc(env: Bindings, opts: GcOptions = {}) {
  const db = env.DB;
  const t = now();
  const s = await getSettings(db);
  let budget = opts.budget ?? (Number(env.GC_BUDGET) || 40);
  const result = {
    stale_uploads: 0,
    objects_deleted: 0,
    uploads_aborted: 0,
    projects_purged: 0,
    sessions_expired: 0,
    shares_expired: 0,
    errors: 0,
    reconciled: false,
  };

  // 1. Uploads that were started but never completed.
  result.stale_uploads = await run(
    db,
    "UPDATE blobs SET status = 'deleted', updated_at = ? WHERE status = 'pending' AND created_at < ?",
    t,
    t - s.gc.pending_upload_ttl_hours * 3_600_000,
  );

  // 2. Remove objects of deleted blobs, then their rows.
  const dead = await all<{ id: string; storage_id: string; object_key: string; upload_id: string | null }>(
    db,
    "SELECT id, storage_id, object_key, upload_id FROM blobs WHERE status = 'deleted' ORDER BY updated_at LIMIT 5000",
  );
  const byStorage = Map.groupBy(dead, (b) => b.storage_id);
  const purged: string[] = [];
  for (const [storageId, rows] of byStorage) {
    if (budget <= 0) break;
    let s3;
    try {
      ({ s3 } = await storageFor(env, storageId));
    } catch (e) {
      console.error(`gc: storage ${storageId}:`, e);
      result.errors++;
      continue;
    }
    // Abort unfinished multipart uploads (one request each, 6 in parallel).
    const multipart = rows.filter((b) => b.upload_id).slice(0, budget);
    budget -= multipart.length;
    const aborted = new Set<string>();
    await pool(multipart, 6, async (b) => {
      try {
        await s3.abortMultipart(b.object_key, b.upload_id!);
        aborted.add(b.id);
        result.uploads_aborted++;
      } catch (e) {
        console.error(`gc: abort ${b.object_key}:`, e);
        result.errors++;
      }
    });
    // Delete objects in batches of 1000 keys.
    const ready = rows.filter((b) => !b.upload_id || aborted.has(b.id));
    for (const batch of chunks(ready, 1000)) {
      if (budget-- <= 0) break;
      try {
        const failed = new Set(await s3.deleteMany(batch.map((b) => b.object_key)));
        for (const b of batch) if (!failed.has(b.object_key)) purged.push(b.id);
        result.objects_deleted += batch.length - failed.size;
        result.errors += failed.size;
      } catch (e) {
        console.error(`gc: delete objects in ${storageId}:`, e);
        result.errors++;
      }
    }
  }
  const stmts: Stmt[] = chunks(purged).map((ids) => stmt(db, `DELETE FROM blobs WHERE id IN (${placeholders(ids.length)})`, ...ids));
  if (stmts.length) await db.batch(stmts);

  // 3. Projects being deleted whose blobs are all gone.
  result.projects_purged = await run(
    db,
    "DELETE FROM projects WHERE status = 'deleting' AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.project_id = projects.id)",
  );

  // 4. Expired credentials / links and old stats.
  result.sessions_expired = await run(db, "DELETE FROM sessions WHERE expires_at < ?", t);
  await run(db, "DELETE FROM cli_logins WHERE expires_at < ?", t - 86_400_000);
  result.shares_expired = await run(db, "DELETE FROM shares WHERE expires_at IS NOT NULL AND expires_at < ?", t - 7 * 86_400_000);
  await run(db, "DELETE FROM stats_daily WHERE day < ?", day(t - 400 * 86_400_000));

  // 5. Usage counters are maintained incrementally; recompute them to heal any drift.
  if (opts.reconcile) {
    await db.batch([
      stmt(
        db,
        `UPDATE projects SET
           used_bytes = (SELECT COALESCE(SUM(size), 0) FROM blobs WHERE project_id = projects.id AND status = 'active'),
           blob_count = (SELECT COUNT(*) FROM blobs WHERE project_id = projects.id AND status = 'active')
         WHERE status = 'active'`,
      ),
      stmt(
        db,
        "UPDATE users SET used_bytes = (SELECT COALESCE(SUM(used_bytes), 0) FROM projects WHERE owner_id = users.id AND status = 'active')",
      ),
    ]);
    result.reconciled = true;
  }
  return result;
}

/** Reconcile once a day (first scheduled run after 03:00 UTC). */
export const isReconcileTime = (t = new Date()) => t.getUTCHours() === 3 && t.getUTCMinutes() < 15;
