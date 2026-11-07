import { describe, expect, it } from "vitest";
import { all } from "../src/db";
import { migrate } from "../src/db/migrations";
import { NodeD1 } from "../src/db/node-sqlite";
import { decrypt, encrypt, hashPassword, verifyPassword } from "../src/lib/crypto";
import { blobName, projectName } from "../src/lib/http";
import { newId, newShareToken, newToken, newUserCode } from "../src/lib/ids";
import { contentDisposition, S3 } from "../src/lib/s3";
import { base32Decode, base32Encode, totpCode, verifyTotp } from "../src/lib/totp";
import { partSizeFor } from "../src/routes/uploads";

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

describe("migrations", () => {
  it("apply once and are idempotent", async () => {
    const db = new NodeD1(":memory:");
    await migrate(db);
    await migrate(db);
    const tables = await all<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["users", "sessions", "projects", "blobs", "shares", "storages", "stats_daily", "_migrations"]),
    );
    db.close();
  });
});
