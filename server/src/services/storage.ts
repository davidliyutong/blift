import { all, one, type DB } from "../db";
import type { Bindings } from "../env";
import { decrypt } from "../lib/crypto";
import { notConfigured, storageDisabled } from "../lib/errors";
import { S3 } from "../lib/s3";
import { deleteProjectStmts } from "./projects";

/** 'disabled': its projects are temporarily unavailable. 'deleting': its projects are gone (GC). */
export type StorageStatus = "active" | "disabled" | "deleting";

export type StorageRow = {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  /** S3 signing region ("auto", "us-east-1"). */
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string; // encrypted
  path_style: number;
  prefix: string;
  /** Display label for users ("Singapore"); "" when not set. */
  location: string;
  is_default: number;
  status: StorageStatus;
  /** While deleting: drop the rows without deleting the objects. */
  keep_objects: number;
  /** JSON state of the last scrub (services/scrub.ts); written without touching updated_at. */
  scrub: string | null;
  created_at: number;
  updated_at: number;
};

// Per-isolate cache of decrypted clients, keyed by everything the client is built from (two edits
// within one millisecond share an updated_at).
const cache = new Map<string, { config: string; s3: S3; row: StorageRow }>();

/**
 * The S3 client of a backend. Only an active backend serves requests; GC, scrubs and the admin's
 * own calls pass `any` to reach a disabled or deleting one.
 */
export async function storageFor(env: Bindings, id: string, opts: { any?: boolean } = {}): Promise<{ s3: S3; row: StorageRow }> {
  const row = await one<StorageRow>(env.DB, "SELECT * FROM storages WHERE id = ?", id);
  if (!row) throw notConfigured(`storage backend ${id} not found`);
  if (row.status !== "active" && !opts.any) throw storageDisabled();
  const config = [row.endpoint, row.region, row.bucket, row.access_key_id, row.secret_access_key, row.path_style].join("\n");
  const hit = cache.get(id);
  if (hit && hit.config === config) return { s3: hit.s3, row };
  const s3 = new S3({
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.access_key_id,
    secretAccessKey: await decrypt(env.APP_SECRET, row.secret_access_key),
    pathStyle: !!row.path_style,
  });
  cache.set(id, { config, s3, row });
  return { s3, row };
}

export const objectKey = (storage: Pick<StorageRow, "prefix">, projectId: string, blobId: string) =>
  `${storage.prefix}${projectId}/${blobId}`;

/** Whether any project or file (in any state) still refers to the backend. */
export async function storageInUse(db: DB, id: string): Promise<boolean> {
  return !!(
    (await one(db, "SELECT 1 AS x FROM projects WHERE storage_id = ? LIMIT 1", id)) ||
    (await one(db, "SELECT 1 AS x FROM blobs WHERE storage_id = ? LIMIT 1", id))
  );
}

/**
 * Deletes up to `limit` active projects of a deleting backend, as their owners would: flagged,
 * usage released, the rest left to GC. Returns how many it deleted.
 */
export async function releaseStorageProjects(db: DB, storageId: string, limit: number): Promise<number> {
  const ps = await all<{ id: string; owner_id: string; used_bytes: number }>(
    db,
    "SELECT id, owner_id, used_bytes FROM projects WHERE storage_id = ? AND status = 'active' LIMIT ?",
    storageId,
    limit,
  );
  if (ps.length) await db.batch(ps.flatMap((p) => deleteProjectStmts(db, p)));
  return ps.length;
}
