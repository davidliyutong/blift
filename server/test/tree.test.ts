import { describe, expect, it } from "vitest";
import { all, one } from "../src/db";
import { migrate } from "../src/db/migrations";
import { NodeD1 } from "../src/db/node-sqlite";
import { runGc } from "../src/services/gc";
import { deleteBlobs, listBlobs, type BlobRow } from "../src/services/projects";
import { chainOf, drainDeletedDirs, findPath, makeDirs, MAX_DEPTH, moveBlobs, splitPath, subtreeFiles, walkPath, withPaths } from "../src/services/tree";

const P = "p";
const mk = { parents: true, userId: "u" };

async function setup() {
  const db = new NodeD1(":memory:");
  await migrate(db);
  await db.batch([
    db.prepare("INSERT INTO users (id, username, used_bytes, created_at) VALUES ('u', 'u', 0, 1)"),
    db.prepare("INSERT INTO projects (id, name, owner_id, storage_id, created_at, updated_at) VALUES ('p', 'p', 'u', 's', 1, 1)"),
  ]);
  let n = 0;
  /** Adds an active file and counts it, as a completed upload does. */
  const file = async (parent: string, name: string, size = 10) => {
    const id = `f${String(n++).padStart(4, "0")}`;
    await db.batch([
      db
        .prepare("INSERT INTO blobs (id, project_id, parent_id, storage_id, object_key, name, size, content_type, status, created_at, updated_at) VALUES (?, 'p', ?, 's', ?, ?, ?, 'x', 'active', ?, 1)")
        .bind(id, parent, id, name, size, n),
      db.prepare("UPDATE projects SET used_bytes = used_bytes + ?, blob_count = blob_count + 1 WHERE id = 'p'").bind(size),
      db.prepare("UPDATE users SET used_bytes = used_bytes + ? WHERE id = 'u'").bind(size),
    ]);
    return id;
  };
  const dir = async (path: string) => (await makeDirs(db, P, "", splitPath(path), mk)).dir.id;
  const row = async (id: string) => (await one<BlobRow>(db, "SELECT * FROM blobs WHERE id = ?", id))!;
  const usage = async () => (await one<{ used_bytes: number; blob_count: number }>(db, "SELECT used_bytes, blob_count FROM projects WHERE id = 'p'"))!;
  return { db, file, dir, row, usage };
}

describe("paths", () => {
  it("splits and validates", () => {
    expect(splitPath("")).toEqual([]);
    expect(splitPath("/")).toEqual([]);
    expect(splitPath("/a//b/")).toEqual(["a", "b"]);
    expect(() => splitPath("a/../b")).toThrow();
    expect(() => splitPath("a\\b")).toThrow();
  });

  it("creates directories like mkdir and mkdir -p", async () => {
    const { db, file } = await setup();
    const { dir: c, created } = await makeDirs(db, P, "", ["a", "b", "c"], mk);
    expect(created).toBe(true);
    expect((await chainOf(db, c.id)).map((s) => s.name)).toEqual(["a", "b", "c"]);
    // Again: the same directory, nothing created.
    const again = await makeDirs(db, P, "", ["a", "b", "c"], mk);
    expect([again.dir.id, again.created]).toEqual([c.id, false]);
    // Without parents: the parent must exist and the name must be free.
    await expect(makeDirs(db, P, "", ["a", "b", "c"], { ...mk, parents: false })).rejects.toThrow(/exists/);
    await expect(makeDirs(db, P, "", ["x", "y"], { ...mk, parents: false })).rejects.toThrow(/not found/);
    const b = (await findPath(db, P, ["a", "b"]))!;
    expect((await makeDirs(db, P, b.id, ["d"], { ...mk, parents: false })).dir.parent_id).toBe(b.id);
    // A file is in the way.
    await file(b.id, "f");
    await expect(makeDirs(db, P, "", ["a", "b", "f", "g"], mk)).rejects.toThrow(/exists/);
    // Same name in another directory or project is fine.
    await makeDirs(db, P, "", ["c"], mk);
    await makeDirs(db, "q", "", ["a"], mk);
    expect((await walkPath(db, P, ["a", "nope", "c"])).length).toBe(1);
    expect(await findPath(db, P, ["a", "b", "f"])).toMatchObject({ kind: "file" });
    expect(await findPath(db, "q", ["a", "b"])).toBeNull();
    db.close();
  });

  it("limits the depth", async () => {
    const { db, dir } = await setup();
    const deep = Array.from({ length: MAX_DEPTH }, (_, i) => `d${i}`);
    const bottom = await dir(deep.join("/"));
    await expect(makeDirs(db, P, bottom, ["more"], mk)).rejects.toThrow(/deep/);
    await expect(makeDirs(db, P, "", [...deep, "more"], mk)).rejects.toThrow(/deep/);
    db.close();
  });

  it("resolves a path with index lookups only", async () => {
    const { db } = await setup();
    const plan = await all<{ detail: string }>(
      db,
      `EXPLAIN QUERY PLAN WITH RECURSIVE seg(i, name) AS (SELECT key, value FROM json_each(?)),
       walk(i, id) AS (SELECT 0, ? UNION ALL
         SELECT w.i + 1, b.id FROM walk w JOIN blobs b INDEXED BY blobs_project_name
           ON b.project_id = ? AND b.parent_id = w.id AND b.status = 'active' AND b.name = (SELECT name FROM seg WHERE seg.i = w.i))
       SELECT b.* FROM walk w JOIN blobs b ON b.id = w.id WHERE w.i > 0 ORDER BY w.i`,
      "[]",
      "",
      P,
    );
    const details = plan.map((r) => r.detail).join("\n");
    expect(details).toMatch(/SEARCH b USING INDEX blobs_project_name \(project_id=\? AND parent_id=\? AND name=\?\)/);
    expect(details).not.toMatch(/SCAN b\b/);
    db.close();
  });
});

describe("moving", () => {
  it("moves and renames in one row, refusing cycles, depth and taken names", async () => {
    const { db, dir, file, row } = await setup();
    const a = await dir("a");
    const ab = await dir("a/b");
    const x = await dir("x");
    const f = await file(ab, "f.txt");
    // A directory moves with its contents.
    expect(await moveBlobs(db, P, [await row(ab)], { to: x })).toBe(1);
    expect((await withPaths(db, [await row(f)]))[0].path).toBe("x/b/f.txt");
    // Rename + move at once.
    await moveBlobs(db, P, [await row(f)], { to: "", name: "g.txt" });
    expect((await withPaths(db, [await row(f)]))[0]).toMatchObject({ path: "g.txt", parent_id: null });
    // Not into itself or below.
    await expect(moveBlobs(db, P, [await row(x)], { to: ab })).rejects.toThrow(/into itself/);
    await expect(moveBlobs(db, P, [await row(x)], { to: x })).rejects.toThrow(/into itself/);
    // Names are unique per directory, files and directories alike.
    await file(a, "b");
    await expect(moveBlobs(db, P, [await row(ab)], { to: a })).rejects.toThrow(/exists/);
    await expect(moveBlobs(db, P, [await row(x)], { name: "a" })).rejects.toThrow(/exists/);
    // Depth: x/b is 2 levels; it does not fit below a directory at MAX_DEPTH - 1.
    const deep = await dir(Array.from({ length: MAX_DEPTH - 1 }, (_, i) => `d${i}`).join("/"));
    await expect(moveBlobs(db, P, [await row(x)], { to: deep })).rejects.toThrow(/deep/);
    expect(await moveBlobs(db, P, [await row(ab)], { to: deep })).toBe(1);
    db.close();
  });
});

describe("directory listings", () => {
  it("list directories first and page with cursors", async () => {
    const { db, dir, file } = await setup();
    const d = await dir("d");
    for (const n of ["zeta", "Alpha", "beta"]) await dir(`d/${n}`);
    for (let i = 0; i < 9; i++) await file(d, `file${i}.txt`, (i % 3) * 5);
    await file("", "root.txt");
    await file(await dir("d/beta"), "nested.txt");
    const project = { id: P, blob_count: 11 };

    for (const sort of ["name", "size", "created_at"] as const)
      for (const order of ["asc", "desc"] as const) {
        const whole = await listBlobs(db, project, { dir: d, sort, order, limit: 100 });
        expect(whole.rows.length).toBe(12);
        expect(whole.total).toBeUndefined();
        expect(whole.rows.slice(0, 3).every((r) => r.kind === "dir")).toBe(true);
        expect(whole.rows.slice(3).every((r) => r.kind === "file")).toBe(true);
        for (const limit of [1, 2, 3, 5]) {
          const ids: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await listBlobs(db, project, { dir: d, sort, order, limit, cursor });
            ids.push(...page.rows.map((r) => r.id));
            cursor = page.next_cursor ?? undefined;
          } while (cursor);
          expect(ids).toEqual(whole.rows.map((r) => r.id));
        }
      }
    const byName = await listBlobs(db, project, { dir: d, sort: "name", order: "asc", limit: 100 });
    expect(byName.rows.slice(0, 3).map((r) => r.name)).toEqual(["Alpha", "beta", "zeta"]);
    // The root, and the listing of all files (no directories, every level).
    expect((await listBlobs(db, project, { dir: "", sort: "name", order: "asc", limit: 100 })).rows.map((r) => r.name)).toEqual(["d", "root.txt"]);
    const flat = await listBlobs(db, project, { sort: "name", order: "asc", limit: 100 });
    expect(flat.rows.length).toBe(11);
    expect(flat.total).toBe(11);
    expect((await withPaths(db, flat.rows)).map((b) => b.path)).toContain("d/beta/nested.txt");
    // Filters inside a directory.
    expect((await listBlobs(db, project, { dir: d, sort: "name", order: "asc", limit: 100, prefix: "FILE1" })).rows.map((r) => r.name)).toEqual(["file1.txt"]);
    expect((await listBlobs(db, project, { dir: d, sort: "name", order: "asc", limit: 100, names: ["beta", "file2.txt", "nested.txt"] })).rows.map((r) => r.name)).toEqual(["beta", "file2.txt"]);
    // Files below a directory, with relative paths.
    expect((await subtreeFiles(db, P, d, 100)).map((f) => f.path)).toContain("beta/nested.txt");
    expect((await subtreeFiles(db, P, d, 4)).length).toBe(4);
    db.close();
  });
});

describe("query plans", () => {
  // A page must read its own rows only: an index range in the order asked for, no sort step.
  it("serves every directory listing from its index", async () => {
    const { db, dir, file } = await setup();
    const d = await dir("d");
    await dir("d/sub");
    for (let i = 0; i < 5; i++) await file(d, `f${i}`);
    const seen: { sql: string; args: unknown[] }[] = [];
    const spy = {
      prepare(sql: string) {
        const st = db.prepare(sql);
        return { ...st, bind: (...args: unknown[]) => (seen.push({ sql, args }), st.bind(...args)) };
      },
      batch: db.batch.bind(db),
    } as unknown as NodeD1;
    for (const sort of ["name", "size", "created_at"] as const)
      for (const order of ["asc", "desc"] as const) {
        const first = await listBlobs(spy, { id: P, blob_count: 5 }, { dir: d, sort, order, limit: 2 });
        await listBlobs(spy, { id: P, blob_count: 5 }, { dir: d, sort, order, limit: 2, cursor: first.next_cursor! });
      }
    expect(seen.length).toBeGreaterThanOrEqual(12);
    for (const q of seen) {
      const plan = (await all<{ detail: string }>(db, `EXPLAIN QUERY PLAN ${q.sql}`, ...q.args)).map((r) => r.detail).join("\n");
      expect(plan, q.sql).toMatch(/SEARCH b USING INDEX blobs_dir_(name|size|created) \(project_id=\? AND parent_id=\? AND kind=\?/);
      expect(plan, q.sql).not.toMatch(/TEMP B-TREE/);
    }
    db.close();
  });
});

describe("deleting directories", () => {
  async function tree() {
    const s = await setup();
    const top = await s.dir("top");
    const sub = await s.dir("top/sub/leaf");
    for (let i = 0; i < 150; i++) await s.file(top, `a${i}`);
    for (let i = 0; i < 120; i++) await s.file(sub, `b${i}`);
    const keep = await s.file("", "keep", 7);
    await s.db.prepare("INSERT INTO shares (id, token, project_id, blob_id, creator_id, created_at) VALUES ('s1', 't1', 'p', ?, 'u', 1)").bind(sub).run();
    return { ...s, top, sub, keep };
  }
  const active = async (db: NodeD1) => (await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM blobs WHERE status = 'active'"))!.n;

  it("flags the directory, then releases its contents within a budget", async () => {
    const { db, top, row, usage } = await tree();
    expect(await usage()).toEqual({ used_bytes: 2707, blob_count: 271 });
    await deleteBlobs(db, { id: P, owner_id: "u" }, [await row(top)]);
    // Unreachable at once, though its rows wait.
    expect(await findPath(db, P, ["top"])).toBeNull();
    expect(await findPath(db, P, ["top", "sub"])).toBeNull();
    // A request drains a bounded amount…
    const spent = await drainDeletedDirs(db, 100, [top]);
    expect(spent).toBeGreaterThanOrEqual(100);
    expect(spent).toBeLessThan(250);
    expect(await active(db)).toBeGreaterThan(1);
    // …and GC the rest: files become deleted blobs, directory rows and shares go, usage is released.
    const env = { DB: db, APP_SECRET: "test-secret-0123456789abcdef0123456789" } as unknown as Parameters<typeof runGc>[0];
    for (let i = 0; i < 5; i++) await runGc(env, { rows: 1000 });
    expect(await active(db)).toBe(1);
    expect((await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM blobs WHERE kind = 'dir'"))!.n).toBe(0);
    expect((await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM shares"))!.n).toBe(0);
    expect(await usage()).toEqual({ used_bytes: 7, blob_count: 1 });
    expect((await one<{ used_bytes: number }>(db, "SELECT used_bytes FROM users WHERE id = 'u'"))!.used_bytes).toBe(7);
    db.close();
  });

  it("drains a small directory in the request", async () => {
    const { db, sub, row, usage } = await tree();
    await deleteBlobs(db, { id: P, owner_id: "u" }, [await row(sub)]);
    await drainDeletedDirs(db, 300, [sub]);
    expect(await usage()).toEqual({ used_bytes: 1507, blob_count: 151 });
    expect(await one(db, "SELECT 1 AS x FROM blobs WHERE id = ?", sub)).toBeNull();
    db.close();
  });

  it("leaves the directories of a deleted project to its own cleanup", async () => {
    const { db } = await tree();
    await db.prepare("UPDATE projects SET status = 'deleting' WHERE id = 'p'").run();
    const env = { DB: db, APP_SECRET: "test-secret-0123456789abcdef0123456789" } as unknown as Parameters<typeof runGc>[0];
    for (let i = 0; i < 5; i++) await runGc(env, { rows: 1000 });
    expect(await active(db)).toBe(0);
    expect((await one<{ n: number }>(db, "SELECT COUNT(*) AS n FROM blobs WHERE kind = 'dir'"))!.n).toBe(0);
    db.close();
  });
});
