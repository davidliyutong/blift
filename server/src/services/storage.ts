import { one } from "../db";
import type { Bindings } from "../env";
import { decrypt } from "../lib/crypto";
import { notConfigured } from "../lib/errors";
import { S3 } from "../lib/s3";

export type StorageRow = {
  id: string;
  name: string;
  provider: string;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret_access_key: string; // encrypted
  path_style: number;
  prefix: string;
  is_default: number;
  created_at: number;
  updated_at: number;
};

// Per-isolate cache of decrypted clients, invalidated by updated_at.
const cache = new Map<string, { updated_at: number; s3: S3; row: StorageRow }>();

export async function storageFor(env: Bindings, id: string): Promise<{ s3: S3; row: StorageRow }> {
  const row = await one<StorageRow>(env.DB, "SELECT * FROM storages WHERE id = ?", id);
  if (!row) throw notConfigured(`storage backend ${id} not found`);
  const hit = cache.get(id);
  if (hit && hit.updated_at === row.updated_at) return hit;
  const s3 = new S3({
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    accessKeyId: row.access_key_id,
    secretAccessKey: await decrypt(env.APP_SECRET, row.secret_access_key),
    pathStyle: !!row.path_style,
  });
  const entry = { updated_at: row.updated_at, s3, row };
  cache.set(id, entry);
  return entry;
}

export const objectKey = (storage: Pick<StorageRow, "prefix">, projectId: string, blobId: string) =>
  `${storage.prefix}${projectId}/${blobId}`;
