import { describe, expect, it } from "vitest";
import { one } from "../src/db";
import { migrate } from "../src/db/migrations";
import { NodeD1 } from "../src/db/node-sqlite";
import type { Bindings } from "../src/env";
import { cancelScrub, parseScrub, scrubStep, startScrub, type ScrubDeps } from "../src/services/scrub";

const PREFIX = "pre/";

/** A bucket listing `PAGE` keys per request, in byte order, like ListObjectsV2. */
function fakeS3(objects: Record<string, number>, page = 3) {
  const keys = Object.keys(objects).sort();
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async list(prefix: string, startAfter: string) {
      calls++;
      const rest = keys.filter((k) => k.startsWith(prefix) && k > startAfter);
      return { objects: rest.slice(0, page).map((key) => ({ key, size: objects[key] })), truncated: rest.length > page };
    },
  };
}

async function setup(files: [name: string, size: number, status: string, createdAt?: number][]) {
  const db = new NodeD1(":memory:");
  await migrate(db);
  await db.batch([
    db.prepare(
      "INSERT INTO storages (id, name, provider, endpoint, region, bucket, access_key_id, secret_access_key, prefix, created_at, updated_at) VALUES ('s', 's', 'other', 'http://x', 'r', 'b', 'k', 'x', ?, 1, 1)",
    ).bind(PREFIX),
    ...files.map(([name, size, status, createdAt]) =>
      db
        .prepare(
          "INSERT INTO blobs (id, project_id, storage_id, object_key, name, size, content_type, status, created_at, updated_at) VALUES (?, 'p', 's', ?, ?, ?, 'x', ?, ?, 1)",
        )
        .bind(name, `${PREFIX}${name}`, name, size, status, createdAt ?? 1),
    ),
    // A directory row: no object, no storage.
    db.prepare("INSERT INTO blobs (id, project_id, storage_id, object_key, name, size, content_type, status, kind, created_at, updated_at) VALUES ('d', 'p', '', '', 'd', 0, 'x', 'active', 'dir', 1, 1)"),
  ]);
  const env = { DB: db } as unknown as Bindings;
  const storage = async () => (await one<{ id: string; prefix: string; scrub: string | null }>(db, "SELECT id, prefix, scrub FROM storages WHERE id = 's'"))!;
  const state = async () => parseScrub((await storage()).scrub)!;
  /** Steps until the scrub stops running; returns the S3 requests made. */
  const finish = async (deps: ScrubDeps, pages = 1) => {
    let n = 0;
    for (let i = 0; i < 100 && (await state()).status === "running"; i++) n += await scrubStep(env, await storage(), pages, deps);
    return n;
  };
  return { db, env, storage, state, finish };
}

// f01…f12: f03 and f09 missing, f05 a different size, p01 pending without object, x01 deleted with
// an object (neither is a problem), two stray objects.
const FILES: [string, number, string][] = [
  ...Array.from({ length: 12 }, (_, i) => [`f${String(i + 1).padStart(2, "0")}`, 10 + i, "active"] as [string, number, string]),
  ["p01", 5, "pending"],
  ["x01", 7, "deleted"],
];
const OBJECTS: Record<string, number> = {
  ...Object.fromEntries(FILES.filter(([n]) => n !== "f03" && n !== "f09" && n !== "p01").map(([n, size]) => [`${PREFIX}${n}`, size])),
  [`${PREFIX}f05`]: 999,
  [`${PREFIX}a-stray`]: 3,
  [`${PREFIX}zz-stray`]: 4,
  "other/f01": 1, // outside the prefix
};

const expectProblems = async (state: () => Promise<ReturnType<typeof parseScrub> & object>) => {
  const s = await state();
  expect(s.status).toBe("done");
  expect([s.files, s.missing, s.size_mismatch, s.orphaned, s.orphaned_bytes]).toEqual([12, 2, 1, 2, 7]);
  expect(s.objects).toBe(Object.keys(OBJECTS).length - 1);
  expect(s.issues.map((i) => `${i.kind}:${i.blob_id ?? i.key}`).sort()).toEqual([
    "missing:f03",
    "missing:f09",
    "orphaned:pre/a-stray",
    "orphaned:pre/zz-stray",
    "size_mismatch:f05",
  ]);
};

describe("scrub", () => {
  it("merges the listing with the rows over many pages", async () => {
    const { db, finish, state } = await setup(FILES);
    await startScrub(db, "s");
    const s3 = fakeS3(OBJECTS);
    await finish({ s3 }, 100);
    await expectProblems(state);
  });

  it("gives the same result one page per run, and when a row page is cut short", async () => {
    for (const rowLimit of [2, 3, 1000]) {
      const { db, finish, state } = await setup(FILES);
      await startScrub(db, "s");
      await finish({ s3: fakeS3(OBJECTS), rowLimit }, 1);
      await expectProblems(state);
    }
  });

  it("stops when canceled and keeps its counters", async () => {
    const { db, env, storage, state } = await setup(FILES);
    await startScrub(db, "s");
    const s3 = fakeS3(OBJECTS);
    expect(await scrubStep(env, await storage(), 1, { s3 })).toBe(1);
    const objects = (await state()).objects;
    await cancelScrub(db, "s");
    expect(await scrubStep(env, await storage(), 5, { s3 })).toBe(0);
    expect([(await state()).status, (await state()).objects]).toEqual(["canceled", objects]);
    expect((await state()).finished_at).not.toBeNull();
  });

  it("does not count a page twice when two runs overlap", async () => {
    const { db, env, storage, state } = await setup(FILES);
    await startScrub(db, "s");
    const stale = await storage();
    const s3 = fakeS3(OBJECTS);
    await scrubStep(env, await storage(), 1, { s3 }); // the other run advances
    const before = await state();
    expect(await scrubStep(env, stale, 3, { s3 })).toBe(1); // lists once, then loses the compare-and-set
    expect(await state()).toEqual(before);
  });

  it("skips files that became active after the listing started", async () => {
    const { db, finish, state } = await setup([["late", 4, "active", Date.now() + 60_000]]);
    await startScrub(db, "s");
    await finish({ s3: fakeS3({}) });
    expect([(await state()).files, (await state()).missing]).toEqual([0, 0]);
  });

  it("fails when the backend cannot be listed", async () => {
    const { db, env, storage, state } = await setup(FILES);
    await startScrub(db, "s");
    const s3 = { list: async () => Promise.reject(new Error("AccessDenied: nope")) };
    expect(await scrubStep(env, await storage(), 3, { s3 })).toBe(1);
    expect([(await state()).status, (await state()).error]).toEqual(["failed", "AccessDenied: nope"]);
  });
});
