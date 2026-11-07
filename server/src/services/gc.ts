// Garbage collection. Runs from the Workers cron trigger (every 15 min) or a timer in Node,
// and on demand from the admin UI. Deleting projects and files only flags rows; the work of
// removing objects and rows happens here, a bounded amount per run:
//
// - S3: every call is a subrequest (Workers free plan: 50 per invocation), so object deletion
//   spends at most `budget` calls. DeleteObjects removes up to 1000 keys per call.
// - D1: every write statement touches at most WRITE_BATCH rows and runs on its own (no large
//   transaction), and a run writes at most `rows` rows. A big backlog (a project with a million
//   files) therefore drains over several runs instead of locking the database for one long write.
import { all, chunks, now, placeholders, run } from "../db";
import type { Bindings } from "../env";
import { pool } from "../lib/http";
import { day } from "./stats";
import { getSettings } from "./settings";
import { storageFor } from "./storage";

/** Rows per write statement. */
export const WRITE_BATCH = 100;

export type GcOptions = {
  /** Max S3 requests for this run (default GC_BUDGET). */
  budget?: number;
  /** Max rows written to the database in this run (default GC_ROWS). */
  rows?: number;
  /** Recompute usage counters from the blobs table (heavier; daily is plenty). */
  reconcile?: boolean;
};

export async function runGc(env: Bindings, opts: GcOptions = {}) {
  const db = env.DB;
  const t = now();
  const s = await getSettings(db);
  let budget = opts.budget ?? (Number(env.GC_BUDGET) || 40);
  let rows = opts.rows ?? (Number(env.GC_ROWS) || 5000);
  const result = {
    stale_uploads: 0,
    blobs_released: 0,
    objects_deleted: 0,
    uploads_aborted: 0,
    projects_purged: 0,
    sessions_expired: 0,
    shares_expired: 0,
    errors: 0,
    /** The row budget ran out: more work is waiting for the next run. */
    more: false,
    reconciled: false,
  };

  const total = rows;
  /**
   * Repeats a write that affects at most WRITE_BATCH rows (`… IN (SELECT … LIMIT 100)`) until it
   * finds nothing more, `limit` rows are written or the run's budget is spent.
   */
  const drain = async (limit: number, sql: string, ...args: unknown[]) => {
    let done = 0;
    while (done < limit && rows > 0) {
      const n = await run(db, sql, ...args);
      done += n;
      rows -= n;
      if (n < WRITE_BATCH) return done;
    }
    result.more = true;
    return done;
  };
  /** Runs `sql` for ids, ≤ 90 per statement (D1: ≤ 100 bound parameters). */
  const eachChunk = async (ids: string[], sql: (ph: string) => string, ...before: unknown[]) => {
    for (const part of chunks(ids, 90)) rows -= await run(db, sql(placeholders(part.length)), ...before, ...part);
  };
  // Each kind of work gets a share of the budget, so a huge backlog of one kind (a project with a
  // million files) cannot starve the others; object removal gets what is left.
  const share = (f: number) => Math.ceil(total * f);

  // 1. Uploads that were started but never completed.
  result.stale_uploads = await drain(
    share(0.1),
    `UPDATE blobs SET status = 'deleted', updated_at = ?
     WHERE id IN (SELECT id FROM blobs WHERE status = 'pending' AND created_at < ? LIMIT ${WRITE_BATCH})`,
    t,
    t - s.gc.pending_upload_ttl_hours * 3_600_000,
  );

  // 2. Deleted projects (only flagged by the API): release their files, shares and members.
  let releaseLeft = share(0.4);
  for (const p of await all<{ id: string }>(db, "SELECT id FROM projects WHERE status = 'deleting' LIMIT 20")) {
    for (const sql of [
      `UPDATE blobs SET status = 'deleted', updated_at = ${t}
       WHERE id IN (SELECT id FROM blobs WHERE project_id = ? AND status != 'deleted' LIMIT ${WRITE_BATCH})`,
      `DELETE FROM shares WHERE id IN (SELECT id FROM shares WHERE project_id = ? LIMIT ${WRITE_BATCH})`,
      `DELETE FROM project_members WHERE rowid IN (SELECT rowid FROM project_members WHERE project_id = ? LIMIT ${WRITE_BATCH})`,
    ]) {
      if (releaseLeft <= 0) break;
      const n = await drain(releaseLeft, sql, p.id);
      releaseLeft -= n;
      if (sql.startsWith("UPDATE")) result.blobs_released += n;
    }
  }

  // 3. Expired credentials / links and old stats.
  const expire = share(0.1);
  result.sessions_expired = await drain(expire, `DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < ? LIMIT ${WRITE_BATCH})`, t);
  await drain(expire, `DELETE FROM cli_logins WHERE id IN (SELECT id FROM cli_logins WHERE expires_at < ? LIMIT ${WRITE_BATCH})`, t - 86_400_000);
  result.shares_expired = await drain(
    expire,
    `DELETE FROM shares WHERE id IN (SELECT id FROM shares WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ${WRITE_BATCH})`,
    t - 7 * 86_400_000,
  );
  await drain(
    expire,
    `DELETE FROM api_keys WHERE id IN (SELECT id FROM api_keys WHERE expires_at IS NOT NULL AND expires_at < ? LIMIT ${WRITE_BATCH})`,
    t - 7 * 86_400_000,
  );
  await drain(
    expire,
    `DELETE FROM stats_daily WHERE rowid IN (SELECT rowid FROM stats_daily WHERE day < ? LIMIT ${WRITE_BATCH})`,
    day(t - 400 * 86_400_000),
  );

  // 4. Remove objects of deleted blobs, then their rows; oldest first, one storage at a time
  //    (index blobs_gc). A storage that cannot be reached is skipped and costs nothing: its rows
  //    wait without holding up the others.
  for (const { id: storageId } of await all<{ id: string }>(db, "SELECT id FROM storages ORDER BY created_at")) {
    if (budget <= 0 || rows <= 0) break;
    const want = Math.min(rows, 5000);
    const group = await all<{ id: string; object_key: string; upload_id: string | null }>(
      db,
      "SELECT id, object_key, upload_id FROM blobs WHERE status = 'deleted' AND storage_id = ? ORDER BY updated_at LIMIT ?",
      storageId,
      want,
    );
    if (group.length === 0) continue;
    if (group.length === want) result.more = true;
    let s3;
    try {
      ({ s3 } = await storageFor(env, storageId));
    } catch (e) {
      console.error(`gc: storage ${storageId}:`, e);
      result.errors++;
      continue;
    }
    const purged: string[] = [];
    // Keys the storage refused go behind the rest of its queue.
    const retry: string[] = [];
    // Abort unfinished multipart uploads (one request each, 6 in parallel).
    const multipart = group.filter((b) => b.upload_id).slice(0, budget);
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
        retry.push(b.id);
      }
    });
    // Delete objects in batches of 1000 keys.
    for (const batch of chunks(group.filter((b) => !b.upload_id || aborted.has(b.id)), 1000)) {
      if (budget-- <= 0) break;
      try {
        const failed = new Set(await s3.deleteMany(batch.map((b) => b.object_key)));
        for (const b of batch) (failed.has(b.object_key) ? retry : purged).push(b.id);
        result.objects_deleted += batch.length - failed.size;
        result.errors += failed.size;
      } catch (e) {
        console.error(`gc: delete objects in ${storageId}:`, e);
        result.errors++;
      }
    }
    await eachChunk(purged, (ph) => `DELETE FROM blobs WHERE id IN (${ph})`);
    await eachChunk(retry, (ph) => `UPDATE blobs SET updated_at = ? WHERE id IN (${ph})`, t);
  }

  // 5. Deleted projects with nothing left.
  result.projects_purged = await drain(
    Infinity,
    `DELETE FROM projects WHERE id IN (
       SELECT id FROM projects p WHERE status = 'deleting'
         AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.project_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM shares s WHERE s.project_id = p.id)
         AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = p.id)
       LIMIT ${WRITE_BATCH})`,
  );

  // 6. Usage counters are maintained incrementally; recompute them to heal any drift.
  if (opts.reconcile) {
    await db.batch([
      db.prepare(
        `UPDATE projects SET
           used_bytes = (SELECT COALESCE(SUM(size), 0) FROM blobs WHERE project_id = projects.id AND status = 'active'),
           blob_count = (SELECT COUNT(*) FROM blobs WHERE project_id = projects.id AND status = 'active')
         WHERE status = 'active'`,
      ),
      db.prepare(
        "UPDATE users SET used_bytes = (SELECT COALESCE(SUM(used_bytes), 0) FROM projects WHERE owner_id = users.id AND status = 'active')",
      ),
    ]);
    result.reconciled = true;
  }
  return result;
}

/** Reconcile once a day (first scheduled run after 03:00 UTC). */
export const isReconcileTime = (t = new Date()) => t.getUTCHours() === 3 && t.getUTCMinutes() < 15;
