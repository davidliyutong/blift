import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { migrate } from "../src/db/migrations";
import { NodeD1 } from "../src/db/node-sqlite";
import { decrypt, encrypt, hashPassword, verifyPassword } from "../src/lib/crypto";
import { blobName, projectName } from "../src/lib/http";
import { newApiKey, newId, newShareToken, newToken, newUserCode } from "../src/lib/ids";
import { installScript } from "../src/lib/install";
import { contentDisposition, S3 } from "../src/lib/s3";
import { runGc, WRITE_BATCH } from "../src/services/gc";
import { BLOB_SORTS, listBlobs } from "../src/services/projects";
import { base32Decode, base32Encode, totpCode, verifyTotp } from "../src/lib/totp";
import { freeName, partSizeFor } from "../src/routes/uploads";

describe("totp", () => {
  it("matches the RFC 6238 SHA-1 test vector", async () => {
    const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));
    expect(await totpCode(secret, Math.floor(59 / 30))).toBe("287082"); // 94287082, last 6 digits
    expect(await totpCode(secret, Math.floor(1111111109 / 30))).toBe("081804");
  });
  it("accepts ±1 step and rejects garbage", async () => {
    const secret = base32Encode(new Uint8Array(20).fill(7));
    const t = 1_700_000_000_000;
    const prev = await totpCode(secret, Math.floor(t / 30_000) - 1);
    expect(await verifyTotp(secret, prev, t)).toBe(true);
    expect(await verifyTotp(secret, "abc", t)).toBe(false);
  });
  it("base32 round-trips", () => {
    const b = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(b))).toEqual(b);
  });
});

describe("crypto", () => {
  it("encrypts and decrypts with the app secret", async () => {
    const ct = await encrypt("s1", "hello");
    expect(ct).toMatch(/^v1\./);
    expect(await decrypt("s1", ct)).toBe("hello");
    await expect(decrypt("s2", ct)).rejects.toThrow();
  });
  it("hashes passwords", async () => {
    const h = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
    expect(await verifyPassword("x", null)).toBe(false);
  });
});

describe("ids", () => {
  it("have the documented shapes", () => {
    expect(newId()).toMatch(/^[a-z2-7]{16}$/);
    expect(newToken()).toMatch(/^blift_[0-9A-Za-z]{32}$/);
    expect(newApiKey()).toMatch(/^bliftk_[0-9A-Za-z]{32}$/);
    expect(newShareToken()).toMatch(/^[0-9A-Za-z]{12}$/);
    expect(newUserCode()).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
  });
});

describe("validation", () => {
  it("project names", () => {
    expect(projectName("my-proj.v2")).toBe("my-proj.v2");
    expect(() => projectName("-x")).toThrow();
    expect(() => projectName("a/b")).toThrow();
  });
  it("blob names are flat", () => {
    expect(blobName("报告 final.pdf")).toBe("报告 final.pdf");
    for (const bad of ["a/b", "a\\b", "..", ".", "", "x\ny"]) expect(() => blobName(bad)).toThrow();
  });
});

describe("s3", () => {
  const cfg = { endpoint: "https://acc.r2.cloudflarestorage.com", region: "auto", bucket: "files", accessKeyId: "AK", secretAccessKey: "SK" };
  it("builds path-style and virtual-hosted URLs", () => {
    expect(new S3({ ...cfg, pathStyle: true }).url("p/b")).toBe("https://acc.r2.cloudflarestorage.com/files/p/b");
    expect(new S3({ ...cfg, pathStyle: false }).url("p/b")).toBe("https://files.acc.r2.cloudflarestorage.com/p/b");
    expect(new S3({ ...cfg, pathStyle: true }).url("", { delete: "" })).toBe("https://acc.r2.cloudflarestorage.com/files?delete=");
  });
  it("presigns without '+' in the query", async () => {
    const url = await new S3({ ...cfg, pathStyle: true }).presignGet("p/b", 3600, "my report (v2).pdf");
    const u = new URL(url);
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(u.search).not.toContain("+");
  });
  it("encodes Content-Disposition per RFC 6266", () => {
    expect(contentDisposition("你好 a.txt")).toBe(`attachment;filename="___a.txt";filename*=UTF-8''%E4%BD%A0%E5%A5%BD%20a.txt`);
  });
});

describe("uploads", () => {
  it("keeps parts ≥ 16 MiB, whole MiB and ≤ 10 000 parts", () => {
    const MiB = 1024 ** 2;
    expect(partSizeFor(100 * MiB)).toBe(16 * MiB);
    const huge = 5 * 1024 ** 4;
    const ps = partSizeFor(huge);
    expect(ps % MiB).toBe(0);
    expect(Math.ceil(huge / ps)).toBeLessThanOrEqual(10_000);
  });
});

describe("freeName", () => {
  // Inbox uploads never replace a file: a taken name gets the next free " (n)" suffix.
  it("numbers taken names before the extension", async () => {
    const db = new NodeD1(":memory:");
    await migrate(db);
    const add = (name: string, status = "active") =>
      db
        .prepare("INSERT INTO blobs (id, project_id, storage_id, object_key, name, size, content_type, status, created_at, updated_at) VALUES (?, 'p', 's', ?, ?, 1, 'x', ?, 1, 1)")
        .bind(newId(), newId(), name, status);
    await db.batch([add("a.txt"), add("a (1).txt"), add("a (2).txt", "deleted"), add(".env"), add("README")]);
    expect(await freeName(db, "p", "new.txt")).toBe("new.txt");
    expect(await freeName(db, "p", "a.txt")).toBe("a (2).txt");
    expect(await freeName(db, "q", "a.txt")).toBe("a.txt");
    expect(await freeName(db, "p", ".env")).toBe(".env (1)");
    expect(await freeName(db, "p", "README")).toBe("README (1)");
    const long = `${"x".repeat(251)}.bin`;
    await db.batch([add(long)]);
    const renamed = await freeName(db, "p", long);
    expect(renamed).toMatch(/^x+ \(1\)\.bin$/);
    expect(renamed.length).toBeLessThanOrEqual(255);
    db.close();
  });
});

describe("listBlobs", () => {
  // Case variants tie under NOCASE, sizes and times repeat: keyset paging must still visit every
  // row exactly once, in the same order as one big ordered query.
  async function seed() {
    const db = new NodeD1(":memory:");
    await migrate(db);
    const names = ["a.txt", "A.txt", "b.txt", "B.TXT", "report 2.pdf", "Report 10.pdf", "_x", "%y", "é.bin", "z"];
    const stmts = [];
    let i = 0;
    for (const base of names)
      for (let k = 0; k < 6; k++, i++)
        stmts.push(
          db
            .prepare(
              "INSERT INTO blobs (id, project_id, storage_id, object_key, name, size, content_type, status, created_at, updated_at) VALUES (?, 'p', 's', ?, ?, ?, 'x', ?, ?, ?)",
            )
            .bind(`id${(i * 7919) % 1000}`.padEnd(8, "0"), `k${i}`, k ? `${base}.${k}` : base, (i % 5) * 10, i % 9 ? "active" : "deleted", 1000 + (i % 4), 1),
        );
    stmts.push(db.prepare("INSERT INTO blobs (id, project_id, storage_id, object_key, name, size, content_type, status, created_at, updated_at) VALUES ('other', 'q', 's', 'k', 'a.txt', 1, 'x', 'active', 1, 1)"));
    await db.batch(stmts);
    const active = (await all<{ n: number }>(db, "SELECT COUNT(*) AS n FROM blobs WHERE project_id = 'p' AND status = 'active'"))[0].n;
    return { db, project: { id: "p", blob_count: active } };
  }

  it.each(BLOB_SORTS.flatMap((sort) => (["asc", "desc"] as const).map((order) => [sort, order] as const)))(
    "pages by %s %s with cursors",
    async (sort, order) => {
      const { db, project } = await seed();
      const whole = await listBlobs(db, project, { sort, order, limit: 1000 });
      expect(whole.next_cursor).toBeNull();
      expect(whole.total).toBe(project.blob_count);
      const ids: string[] = [];
      let cursor: string | undefined;
      let first = true;
      do {
        const page = await listBlobs(db, project, { sort, order, limit: 7, cursor });
        expect(page.total).toBe(first ? project.blob_count : undefined);
        ids.push(...page.rows.map((b) => b.id));
        cursor = page.next_cursor ?? undefined;
        first = false;
      } while (cursor);
      expect(ids).toEqual(whole.rows.map((b) => b.id));
      db.close();
    },
  );

  it("filters by prefix, exact names and substring", async () => {
    const { db, project } = await seed();
    const byPrefix = await listBlobs(db, project, { sort: "name", order: "asc", limit: 100, prefix: "rep" });
    expect(byPrefix.rows.map((b) => b.name).every((n) => n.toLowerCase().startsWith("rep"))).toBe(true);
    expect(byPrefix.total).toBe(byPrefix.rows.length);
    expect(byPrefix.rows.length).toBeGreaterThan(0);
    // "a.txt" was seeded as deleted: only active files match.
    const exact = await listBlobs(db, project, { sort: "name", order: "asc", limit: 100, names: ["a.txt", "A.txt", "b.txt", "missing"] });
    expect(exact.rows.map((b) => b.name).sort()).toEqual(["A.txt", "b.txt"]);
    // LIKE wildcards in q are literal.
    const pct = await listBlobs(db, project, { sort: "name", order: "asc", limit: 100, q: "%" });
    expect(pct.rows.map((b) => b.name).every((n) => n.includes("%"))).toBe(true);
    await expect(listBlobs(db, project, { sort: "size", order: "asc", limit: 5, cursor: "garbage" })).rejects.toThrow(/cursor/);
    const page = await listBlobs(db, project, { sort: "name", order: "asc", limit: 5 });
    await expect(listBlobs(db, project, { sort: "size", order: "asc", limit: 5, cursor: page.next_cursor! })).rejects.toThrow(/cursor/);
    db.close();
  });
});

describe("gc", () => {
  // Wraps the database to record how many rows each single write statement changed.
  function recording(db: NodeD1) {
    const writes: number[] = [];
    const wrapped = {
      prepare(sql: string) {
        const st = db.prepare(sql);
        const wrap = (inner: typeof st): typeof st => ({
          bind: (...v: unknown[]) => wrap(inner.bind(...v)),
          first: (...a: []) => inner.first(...a),
          all: (...a: []) => inner.all(...a),
          run: async () => {
            const r = await inner.run();
            writes.push(r.meta.changes);
            return r;
          },
        });
        return wrap(st);
      },
      batch: (stmts: Parameters<NodeD1["batch"]>[0]) => db.batch(stmts),
    };
    return { wrapped, writes };
  }

  it("drains a deleted project and expired rows in small writes within the row budget", async () => {
    const db = new NodeD1(":memory:");
    await migrate(db);
    const t = Date.now();
    const seed = [db.prepare("INSERT INTO projects (id, name, owner_id, storage_id, status, created_at, updated_at) VALUES ('p', 'big', 'u', 'gone', 'deleting', 1, 1)")];
    for (let i = 0; i < 250; i++)
      seed.push(
        db
          .prepare("INSERT INTO blobs (id, project_id, storage_id, object_key, name, size, content_type, status, created_at, updated_at) VALUES (?, 'p', 'gone', ?, ?, 1, 'x', 'active', 1, 1)")
          .bind(`b${i}`, `k${i}`, `f${i}`),
      );
    for (let i = 0; i < 130; i++)
      seed.push(db.prepare("INSERT INTO shares (id, token, project_id, creator_id, created_at) VALUES (?, ?, 'p', 'u', 1)").bind(`s${i}`, `t${i}`));
    for (let i = 0; i < 230; i++)
      seed.push(
        db
          .prepare("INSERT INTO sessions (id, user_id, kind, created_at, expires_at, last_used_at) VALUES (?, 'u', 'web', 1, ?, 1)")
          .bind(`x${i}`, t - 1000),
      );
    await db.batch(seed);

    const { wrapped, writes } = recording(db);
    const env = { DB: wrapped, APP_SECRET: "test-secret-0123456789abcdef0123456789" } as unknown as Parameters<typeof runGc>[0];
    const first = await runGc(env, { rows: 150 });
    expect(first.more).toBe(true);
    expect(Math.max(...writes)).toBeLessThanOrEqual(WRITE_BATCH);
    // The budget is checked before each statement, so a run may overshoot by one batch at most.
    expect(writes.reduce((a, b) => a + b, 0)).toBeLessThan(150 + WRITE_BATCH);

    for (let i = 0; i < 20; i++) await runGc(env, { rows: 150 });
    expect(Math.max(...writes)).toBeLessThanOrEqual(WRITE_BATCH);
    const left = async (sql: string) => (await all<{ n: number }>(db, sql))[0].n;
    expect(await left("SELECT COUNT(*) AS n FROM blobs WHERE status != 'deleted'")).toBe(0);
    expect(await left("SELECT COUNT(*) AS n FROM shares")).toBe(0);
    expect(await left("SELECT COUNT(*) AS n FROM sessions")).toBe(0);
    // Its storage is gone, so the objects (and the project) wait instead of blocking anything.
    expect(await left("SELECT COUNT(*) AS n FROM projects")).toBe(1);
    db.close();
  });
});

describe("migrations", () => {
  it("apply once and are idempotent", async () => {
    const db = new NodeD1(":memory:");
    await migrate(db);
    await migrate(db);
    const tables = await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["users", "sessions", "projects", "blobs", "shares", "storages", "stats_daily", "_migrations"]),
    );
    const storageCols = await all<{ name: string; dflt_value: string }>(db, "PRAGMA table_info(storages)");
    expect(storageCols.find((c) => c.name === "location")?.dflt_value).toBe("''");
    db.close();
  });
});

describe("install.sh", () => {
  // Runs the script the way `curl … | sh` does. file:// URLs stand in for the server's relay
  // (<server>/api/cli/download) and for GitHub Releases, serving fake release files.
  it.each(["sh", "bash"])("downloads via the server, falls back to GitHub, verifies the checksum (%s)", (shell) => {
    const root = mkdtempSync(join(tmpdir(), "blift-install-"));
    try {
      const server = `file://${root}/srv`;
      const rel = join(root, "srv", "api", "cli", "download", "v9.8.7");
      mkdirSync(rel, { recursive: true });
      const sums: string[] = [];
      for (const os of ["linux", "darwin"])
        for (const arch of ["amd64", "arm64"]) {
          const name = `blift_9.8.7_${os}_${arch}`;
          mkdirSync(join(root, "pkg", name), { recursive: true });
          // `version` prints the version; `login` records how it was called (the key must come
          // from the environment, not the command line).
          const fake = `#!/bin/sh\ncase $1 in login) echo "login $* key=$BLIFT_API_KEY" ;; *) echo 'blift v9.8.7 (test)' ;; esac\n`;
          writeFileSync(join(root, "pkg", name, "blift"), fake, { mode: 0o755 });
          execFileSync("tar", ["-C", join(root, "pkg"), "-czf", join(rel, `${name}.tar.gz`), name]);
          sums.push(`${createHash("sha256").update(readFileSync(join(rel, `${name}.tar.gz`))).digest("hex")}  ${name}.tar.gz`);
        }
      writeFileSync(join(rel, "SHA256SUMS"), `${sums.join("\n")}\n`);
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        LANG: "zh_CN.UTF-8", // bash 3.2 would read "$x）" as one name: messages must use ${x}
        SHELL: "/bin/zsh",
      };
      const run = (script: string, extra: Record<string, string> = {}) => {
        const r = spawnSync(shell, [], { input: script, env: { ...env, ...extra } });
        return { status: r.status, out: r.stdout.toString(), err: r.stderr.toString() };
      };

      // 1. Through the server's relay; GitHub is never needed.
      const viaServer = run(installScript(server, "9.8.7", `file://${root}/no-github`));
      expect(viaServer.status, viaServer.err).toBe(0);
      expect(viaServer.out).toContain("blift v9.8.7 (test)");
      expect(viaServer.out).not.toContain("无法从");
      // Installs into the user's own ~/.local/bin and tells how to put it on PATH.
      expect(readFileSync(join(root, ".local", "bin", "blift"), "utf8")).toContain("v9.8.7");
      expect(viaServer.out).toContain(`echo 'export PATH="${join(root, ".local", "bin")}:$PATH"' >> ~/.zshrc`);
      expect(viaServer.out).toContain(`blift login --server ${server}`);

      // 2. The relay fails (an intranet server without internet access): GitHub directly. The quote
      //    in the server URL must survive sh quoting.
      const odd = `file://${root}/o'neil`;
      const fallback = run(installScript(odd, "9.8.7", `file://${root}/srv/api/cli/download`));
      expect(fallback.status, fallback.err).toBe(0);
      expect(fallback.out).toContain(`无法从 ${odd}/api/cli/download 下载`);
      expect(fallback.out).toContain(`blift login --server ${odd}`);

      // 3. BLIFT_API_KEY signs in right after installing, without the key on the command line.
      const withKey = run(installScript(server, "9.8.7", `file://${root}/no-github`), { BLIFT_API_KEY: "bliftk_test" });
      expect(withKey.status, withKey.err).toBe(0);
      expect(withKey.out).toContain(`login login --server ${server} --no-browser key=bliftk_test`);
      expect(withKey.out).not.toContain(`blift login --server`);

      // 4. A tampered archive is refused.
      writeFileSync(join(rel, "SHA256SUMS"), sums.map((l) => "0".repeat(64) + l.slice(64)).join("\n"));
      const bad = run(installScript(server, "9.8.7"), { LANG: "C" });
      expect(bad.status).not.toBe(0);
      expect(bad.err).toContain("SHA-256 mismatch");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
