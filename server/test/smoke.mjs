// End-to-end smoke test against a running server and a real S3 bucket.
//
//   BASE=http://localhost:8787 BOOTSTRAP_SECRET=... \
//   S3_ENDPOINT=http://localhost:19000 S3_BUCKET=blift-test S3_ACCESS_KEY=... S3_SECRET_KEY=... \
//   node test/smoke.mjs
//
// Expects a fresh database (it performs the one-off bootstrap). `make smoke` sets it all up.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import http from "node:http";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

const BASE = process.env.BASE ?? "http://localhost:8787";
const env = (k, d) => process.env[k] ?? d ?? assert.fail(`${k} is required`);

let cookie = "";
async function api(method, path, body, { auth = "cookie", headers = {}, expect } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["content-type"] = "application/json";
  if (auth === "cookie" && cookie) h.cookie = cookie;
  if (auth && auth !== "cookie") h.authorization = `Bearer ${auth}`;
  const res = await fetch(BASE + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("blift_session="));
  if (setCookie && auth === "cookie") cookie = setCookie.split(";")[0];
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (expect !== undefined) {
    assert.equal(res.status, expect, `${method} ${path} → ${res.status} ${text}`);
  } else if (res.status >= 400) {
    assert.fail(`${method} ${path} → ${res.status} ${text}`);
  }
  return json;
}
const errCode = async (p) => (await p)?.error?.code;
const step = (s) => console.log(`✓ ${s}`);
const sha = (b) => createHash("sha256").update(b).digest("hex");

function totp(secret, t = Date.now()) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of secret) bits += A.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

async function upload(projectId, name, data, extra = {}) {
  const init = await api("POST", `/api/projects/${projectId}/uploads`, { name, size: data.length, content_type: "application/octet-stream", ...extra }, { expect: 201 });
  if (init.mode === "single") {
    const r = await fetch(init.url, { method: "PUT", body: data });
    assert.equal(r.status, 200, `PUT single → ${r.status} ${await r.text()}`);
    return api("POST", `/api/uploads/${init.blob_id}/complete`, {});
  }
  const nums = Array.from({ length: init.part_count }, (_, i) => i + 1);
  const { urls } = await api("POST", `/api/uploads/${init.blob_id}/parts`, { part_numbers: nums });
  await Promise.all(
    nums.map(async (n) => {
      const r = await fetch(urls[n], { method: "PUT", body: data.subarray((n - 1) * init.part_size, n * init.part_size) });
      assert.equal(r.status, 200, `PUT part ${n} → ${r.status}`);
    }),
  );
  return api("POST", `/api/uploads/${init.blob_id}/complete`, {}); // server lists the parts itself
}

/** Anonymous upload through an upload link (single or multipart); returns {name, size}. */
async function shareUpload(token, access, name, data) {
  const init = await api("POST", `/api/public/shares/${token}/uploads`, { name, size: data.length }, { auth: null, headers: access ? { "x-share-access": access } : {}, expect: 201 });
  const headers = { "x-upload-token": init.upload_token };
  if (init.mode === "single") {
    const r = await fetch(init.url, { method: "PUT", body: data });
    assert.equal(r.status, 200, `PUT single → ${r.status} ${await r.text()}`);
  } else {
    const nums = Array.from({ length: init.part_count }, (_, i) => i + 1);
    const { urls } = await api("POST", `/api/public/shares/${token}/uploads/${init.blob_id}/parts`, { part_numbers: nums }, { auth: null, headers });
    await Promise.all(
      nums.map(async (n) => {
        const r = await fetch(urls[n], { method: "PUT", body: data.subarray((n - 1) * init.part_size, n * init.part_size) });
        assert.equal(r.status, 200, `PUT part ${n} → ${r.status}`);
      }),
    );
  }
  return api("POST", `/api/public/shares/${token}/uploads/${init.blob_id}/complete`, {}, { auth: null, headers });
}

// Minimal OIDC provider imitating Authentik (issuer ends with "/application/o/<slug>/").
async function startIdp() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const codes = new Map();
  const idp = { alg: "HS256", user: null, issuer: "" };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, idp.issuer);
    const json = (o, status = 200) => (res.writeHead(status, { "content-type": "application/json" }), res.end(JSON.stringify(o)));
    const path = u.pathname.replace("/application/o/blift", "");
    if (path === "/.well-known/openid-configuration")
      return json({
        issuer: idp.issuer,
        authorization_endpoint: `${idp.issuer}authorize/`,
        token_endpoint: `${idp.issuer}token/`,
        userinfo_endpoint: `${idp.issuer}userinfo/`,
        jwks_uri: `${idp.issuer}jwks/`,
        id_token_signing_alg_values_supported: ["HS256", "RS256"],
      });
    if (path === "/jwks/") return json({ keys: [jwk] });
    if (path === "/userinfo/") return json({ sub: idp.user.sub, groups: idp.user.groups });
    if (path === "/authorize/") {
      const q = u.searchParams;
      assert.equal(q.get("client_id"), "blift");
      assert.equal(q.get("code_challenge_method"), "S256");
      const code = randomBytes(8).toString("hex");
      codes.set(code, { nonce: q.get("nonce"), challenge: q.get("code_challenge"), redirect: q.get("redirect_uri") });
      res.writeHead(302, { location: `${q.get("redirect_uri")}?code=${code}&state=${q.get("state")}` });
      return res.end();
    }
    if (path === "/token/") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const f = new URLSearchParams(raw);
      const c = codes.get(f.get("code"));
      const pkce = createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url");
      if (!c || f.get("client_secret") !== "oidc-secret" || pkce !== c.challenge || f.get("redirect_uri") !== c.redirect)
        return json({ error: "invalid_grant" }, 400);
      const { groups, ...claims } = idp.user; // groups only via userinfo, like a minimal Authentik mapping
      const token = new SignJWT({ ...claims, nonce: c.nonce })
        .setProtectedHeader(idp.alg === "HS256" ? { alg: "HS256" } : { alg: "RS256", kid: "k1" })
        .setIssuer(idp.issuer)
        .setAudience("blift")
        .setIssuedAt()
        .setExpirationTime("5m");
      const id_token = await token.sign(idp.alg === "HS256" ? new TextEncoder().encode("oidc-secret") : privateKey);
      return json({ id_token, access_token: "at-" + f.get("code"), token_type: "Bearer" });
    }
    json({ error: "not found" }, 404);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  idp.issuer = `http://127.0.0.1:${server.address().port}/application/o/blift/`;
  idp.close = () => server.close();
  return idp;
}

/** Plays the browser through start → IdP → callback; returns the new session cookie and Location. */
async function oidcLogin(redirect = "/projects") {
  const start = await fetch(`${BASE}/api/auth/oidc/start?redirect=${encodeURIComponent(redirect)}`, { redirect: "manual" });
  assert.equal(start.status, 302, `oidc start → ${start.status} ${await start.text()}`);
  const state = start.headers.getSetCookie().find((c) => c.startsWith("blift_oidc=")).split(";")[0];
  const authz = await fetch(start.headers.get("location"), { redirect: "manual" });
  assert.equal(authz.status, 302);
  const cb = await fetch(authz.headers.get("location"), { redirect: "manual", headers: { cookie: state } });
  assert.equal(cb.status, 302);
  const session = cb.headers.getSetCookie().find((c) => c.startsWith("blift_session="))?.split(";")[0];
  return { location: cb.headers.get("location"), session };
}

/** A share link fetched like wget does (Accept: *\/*), or with other headers; redirects not followed. */
const viaLink = (path, headers = { accept: "*/*", "user-agent": "Wget/1.25.0" }, method = "GET") =>
  fetch(BASE + path, { method, headers, redirect: "manual" });

async function fetchBytes(url) {
  const r = await fetch(url);
  assert.equal(r.status, 200, `GET ${url} → ${r.status}`);
  return { data: Buffer.from(await r.arrayBuffer()), disposition: r.headers.get("content-disposition") };
}

// ---------------------------------------------------------------------------

if (process.env.CREATE_BUCKET) {
  const { AwsClient } = await import("aws4fetch");
  const aws = new AwsClient({ accessKeyId: env("S3_ACCESS_KEY"), secretAccessKey: env("S3_SECRET_KEY"), service: "s3", region: "us-east-1" });
  const r = await aws.fetch(`${env("S3_ENDPOINT")}/${env("S3_BUCKET")}`, { method: "PUT" });
  assert.ok(r.ok || r.status === 409, `create bucket → ${r.status} ${await r.text()}`);
}

const info = await api("GET", "/api/info");
assert.equal(info.setup_required, true, "expected a fresh server");
assert.equal(await errCode(api("POST", "/api/setup", { secret: "nope", username: "admin", password: "password123" }, { expect: 403 })), "invalid_secret");
await api("POST", "/api/setup", { secret: env("BOOTSTRAP_SECRET"), username: "admin", password: "password123", email: "admin@example.com" }, { expect: 201 });
assert.equal(await errCode(api("POST", "/api/setup", { secret: env("BOOTSTRAP_SECRET"), username: "x2", password: "password123" }, { expect: 409 })), "setup_done");
const me = await api("GET", "/api/auth/me");
assert.equal(me.user.role, "admin");
step("bootstrap admin (one-off secret)");

for (const path of ["/install.sh", "/api/cli/install.sh"]) {
  const r = await fetch(BASE + path);
  const sh = await r.text();
  assert.equal(r.status, 200, `GET ${path} → ${r.status}`);
  assert.match(r.headers.get("content-type") ?? "", /^text\/plain/);
  assert.ok(sh.startsWith("#!/bin/sh") && sh.includes(`SERVER='${BASE}'`) && sh.includes(`SERVER_VERSION='${info.version}'`), sh.slice(0, 400));
}
step("CLI installer at /install.sh");

// The CLI download relay (a published release, fetched from GitHub by the server).
const relay = (p) => fetch(`${BASE}/api/cli/download/${p}`);
const sumsRes = await relay("v0.1.0/SHA256SUMS");
assert.equal(sumsRes.status, 200);
const sums = await sumsRes.text();
const archive = Buffer.from(await (await relay("v0.1.0/blift_0.1.0_linux_amd64.tar.gz")).arrayBuffer());
assert.ok(sums.includes(`${sha(archive)}  blift_0.1.0_linux_amd64.tar.gz`), "relayed archive matches SHA256SUMS");
for (const p of ["v0.1.0/blift_0.2.0_linux_amd64.tar.gz", "v0.1.0/README.md", "latest/SHA256SUMS", "v0.1.0/..%2F..%2Fx"])
  assert.equal((await relay(p)).status, 404, p);
const latestRes = await api("GET", "/api/cli/latest", undefined, { auth: null });
assert.match(latestRes.version, /^\d+\.\d+\.\d+/);
step(`CLI download relay (${archive.length} bytes, checksum ok; other paths 404), latest release v${latestRes.version}`);

const storageCfg = {
  name: "local",
  provider: "rustfs",
  endpoint: env("S3_ENDPOINT"),
  region: "us-east-1",
  bucket: env("S3_BUCKET"),
  access_key_id: env("S3_ACCESS_KEY"),
  secret_access_key: env("S3_SECRET_KEY"),
  path_style: true,
  prefix: "smoke",
  location: " Singapore ",
};
const test = await api("POST", "/api/admin/storages/test", storageCfg);
assert.equal(test.ok, true, `storage test failed: ${test.error}`);
const storage = await api("POST", "/api/admin/storages", storageCfg, { expect: 201 });
assert.equal(storage.is_default, true);
assert.equal(storage.prefix, "smoke/");
assert.equal(storage.location, "Singapore");
assert.deepEqual((await api("GET", "/api/storages")).storages.map((s) => [s.id, s.location]), [[storage.id, "Singapore"]]);
assert.equal(await errCode(api("PATCH", `/api/admin/storages/${storage.id}`, { location: "x".repeat(65) }, { expect: 400 })), "bad_request");
const cors = await api("POST", `/api/admin/storages/${storage.id}/cors`, {});
step(`storage backend (test ${test.latency_ms} ms, CORS ${cors.ok ? "applied" : `not supported: ${cors.error}`}, location label)`);

const project = await api("POST", "/api/projects", { name: "demo", description: "smoke" }, { expect: 201 });
assert.deepEqual([project.storage_id, project.storage_name, project.storage_location], [storage.id, "local", "Singapore"]);
assert.equal(await errCode(api("POST", "/api/projects", { name: "nowhere", storage_id: "nope" }, { expect: 404 })), "not_found");
// A second backend: users pick it by id; the default one is listed first.
const storage2 = await api("POST", "/api/admin/storages", { ...storageCfg, name: "second", prefix: "smoke2", location: "US West" }, { expect: 201 });
assert.deepEqual(
  (await api("GET", "/api/storages")).storages.map((s) => [s.name, s.location, s.is_default]),
  [["local", "Singapore", true], ["second", "US West", false]],
);
const elsewhere = await api("POST", "/api/projects", { name: "elsewhere", storage_id: storage2.id }, { expect: 201 });
assert.deepEqual([elsewhere.storage_id, elsewhere.storage_name, elsewhere.storage_location], [storage2.id, "second", "US West"]);
assert.equal(await errCode(api("POST", "/api/projects", { name: "DEMO" }, { expect: 409 })), "name_taken");
assert.equal(await errCode(api("POST", "/api/projects", { name: "bad/name" }, { expect: 400 })), "bad_request");
step("project create (default or chosen backend, with its location) + name rules");

const small = Buffer.from("hello blift — 你好\n");
const b1 = await upload(project.id, "hello 你好.txt", small);
assert.equal(b1.size, small.length);
const big = randomBytes(70 * 1024 * 1024 + 123);
const b2 = await upload(project.id, "big.bin", big);
assert.equal(b2.size, big.length);
assert.equal(await errCode(api("POST", `/api/projects/${project.id}/uploads`, { name: "big.bin", size: 1 }, { expect: 409 })), "name_taken");
step("single + multipart (5 parts, server-side ListParts) direct uploads");

const list = await api("GET", `/api/projects/${project.id}/blobs?sort=name&order=asc`);
assert.deepEqual(list.blobs.map((b) => b.name), ["big.bin", "hello 你好.txt"]);
assert.equal(list.total, 2);
const p2 = await api("GET", `/api/projects/${project.id}`);
assert.equal(p2.used_bytes, small.length + big.length);
assert.equal(p2.blob_count, 2);

const d1 = await api("GET", `/api/blobs/${b1.id}/download`);
const got1 = await fetchBytes(d1.url);
assert.equal(sha(got1.data), sha(small));
assert.match(got1.disposition ?? "", /filename\*=UTF-8''hello%20%E4%BD%A0%E5%A5%BD\.txt/);
const d2 = await api("GET", `/api/blobs/${b2.id}/download`);
assert.equal(sha((await fetchBytes(d2.url)).data), sha(big));
step("presigned downloads (content + Content-Disposition verified)");

// Overwrite keeps share links pointing at the new version.
const share1 = await api("POST", "/api/shares", { project_id: project.id, blob_id: b1.id }, { expect: 201 });
const small2 = Buffer.from("version 2");
const b1v2 = await upload(project.id, "hello 你好.txt", small2, { overwrite: true });
const pub1 = await api("GET", `/api/public/shares/${share1.token}`, undefined, { auth: null });
assert.equal(pub1.share.locked, false);
assert.equal(pub1.blobs[0].id, b1v2.id);
const pd1 = await api("GET", `/api/public/shares/${share1.token}/blobs/${b1v2.id}/download`, undefined, { auth: null });
assert.equal((await fetchBytes(pd1.url)).data.toString(), "version 2");
step("overwrite upload; share follows the new version");

// Share links for wget and curl: /s/<token> and /s/<token>/<name> redirect to the file.
assert.equal(share1.download_url, `${BASE}/s/${share1.token}/${encodeURIComponent("hello 你好.txt")}`);
for (const path of [`/s/${share1.token}`, new URL(share1.download_url).pathname]) {
  const r = await viaLink(path);
  assert.equal(r.status, 302, `${path} → ${r.status} ${await r.text()}`);
  const got = await fetchBytes(r.headers.get("location"));
  assert.equal(got.data.toString(), "version 2");
  assert.match(got.disposition ?? "", /filename\*=UTF-8''hello%20%E4%BD%A0%E5%A5%BD\.txt/);
}
// Browsers still get the web page (when this server has one: web/dist is not built in CI).
const asPage = await viaLink(`/s/${share1.token}`, { accept: "text/html,application/xhtml+xml,*/*;q=0.8" });
const hasWeb = existsSync(new URL("../../web/dist/index.html", import.meta.url));
assert.equal(asPage.status, hasWeb ? 200 : 404);
if (hasWeb) assert.match(`${asPage.headers.get("content-type")} ${await asPage.text()}`, /^text\/html.*<div id="root">/s);
// HEAD describes the file without counting; the limit holds; errors are plain text.
const once = await api("POST", "/api/shares", { project_id: project.id, blob_id: b1v2.id, max_downloads: 1 }, { expect: 201 });
const onceHead = await viaLink(`/s/${once.token}`, undefined, "HEAD");
assert.deepEqual([onceHead.status, onceHead.headers.get("content-length")], [200, String(small2.length)]);
assert.equal((await viaLink(`/s/${once.token}`)).status, 302);
const onceGone = await viaLink(new URL(once.download_url).pathname);
assert.deepEqual([onceGone.status, await onceGone.text()], [410, "this share reached its download limit (share_exhausted)\n"]);
assert.equal((await viaLink(`/s/${once.token}/other.txt`)).status, 410);
assert.equal((await viaLink("/s/nope")).status, 404);
assert.equal((await api("GET", `/api/shares?project_id=${project.id}`)).shares.find((s) => s.id === once.id).download_count, 1);
step(`share links for wget/curl: 302 to the file (by token and by name), HEAD, limit, ${hasWeb ? "HTML page for browsers" : "no web/dist"}`);

// Listing a larger project: keyset cursors, prefix and exact-name lookups, paged public shares.
const lp = await api("POST", "/api/projects", { name: "listing" }, { expect: 201 });
const names = ["Alpha.txt", "alpha-2.txt", "beta.txt", "Gamma.log", "gamma.txt", "delta 1.txt", "delta 2.txt"];
for (const n of names) await upload(lp.id, n, Buffer.from(n));
const ordered = (await api("GET", `/api/projects/${lp.id}/blobs?sort=name&order=asc&limit=100`)).blobs.map((b) => b.name);
assert.equal(ordered.length, names.length);
const walked = [];
let pageRes = await api("GET", `/api/projects/${lp.id}/blobs?sort=name&order=asc&limit=3`);
assert.equal(pageRes.total, names.length);
for (;;) {
  walked.push(...pageRes.blobs.map((b) => b.name));
  if (!pageRes.next_cursor) break;
  pageRes = await api("GET", `/api/projects/${lp.id}/blobs?sort=name&order=asc&limit=3&cursor=${encodeURIComponent(pageRes.next_cursor)}`);
  assert.equal(pageRes.total, undefined);
}
assert.deepEqual(walked, ordered);
const byPrefix = await api("GET", `/api/projects/${lp.id}/blobs?prefix=GAM&sort=name&order=asc`);
assert.deepEqual(byPrefix.blobs.map((b) => b.name).sort(), ["Gamma.log", "gamma.txt"]);
assert.equal(byPrefix.total, 2);
const byName = await api("GET", `/api/projects/${lp.id}/blobs?name=${encodeURIComponent("delta 2.txt")}&name=beta.txt&name=nope`);
assert.deepEqual(byName.blobs.map((b) => b.name).sort(), ["beta.txt", "delta 2.txt"]);
const nameCursor = (await api("GET", `/api/projects/${lp.id}/blobs?sort=name&limit=1`)).next_cursor;
assert.equal(await errCode(api("GET", `/api/projects/${lp.id}/blobs?sort=size&cursor=${encodeURIComponent(nameCursor)}`, undefined, { expect: 400 })), "bad_request");
const lshare = await api("POST", "/api/shares", { project_id: lp.id }, { expect: 201 });
const pubPage1 = await api("GET", `/api/public/shares/${lshare.token}?limit=4`, undefined, { auth: null });
assert.equal(pubPage1.share.file_count, names.length);
assert.equal(pubPage1.share.total_bytes, names.reduce((n, x) => n + Buffer.byteLength(x), 0));
assert.equal(pubPage1.blobs.length, 4);
const pubPage2 = await api("GET", `/api/public/shares/${lshare.token}?limit=4&cursor=${encodeURIComponent(pubPage1.next_cursor)}`, undefined, { auth: null });
assert.equal(pubPage2.next_cursor, null);
assert.deepEqual([...pubPage1.blobs, ...pubPage2.blobs].map((b) => b.name), ordered);
assert.equal(lshare.download_url, null);
const linkList = await viaLink(`/s/${lshare.token}`, { accept: "*/*", "user-agent": "curl/8.7.1" });
assert.equal(linkList.status, 200);
assert.match(linkList.headers.get("content-type") ?? "", /^text\/plain/);
const links = (await linkList.text()).trim().split("\n");
assert.deepEqual(links, ordered.map((n) => `${BASE}/s/${lshare.token}/${encodeURIComponent(n)}`));
const viaList = await viaLink(new URL(links[ordered.indexOf("delta 2.txt")]).pathname);
assert.equal((await fetchBytes(viaList.headers.get("location"))).data.toString(), "delta 2.txt");
assert.equal((await viaLink(`/s/${lshare.token}/nope.txt`)).status, 404);
step(`listing: cursor pages, prefix, exact names, paged public share (${names.length} files), text list of direct links`);

// Directories: mkdir, uploads into them, listings by path, move/rename, shares, recursive delete.
const tp = await api("POST", "/api/projects", { name: "tree" }, { expect: 201 });
const T = `/api/projects/${tp.id}`;
const dirC = await api("POST", `${T}/dirs`, { path: "a/b/c", parents: true }, { expect: 201 });
assert.deepEqual([dirC.kind, dirC.name, dirC.path, dirC.size], ["dir", "c", "a/b/c", 0]);
assert.equal((await api("POST", `${T}/dirs`, { path: "/a/b/c/", parents: true }, { expect: 200 })).id, dirC.id);
assert.equal(await errCode(api("POST", `${T}/dirs`, { path: "a/b/c" }, { expect: 409 })), "name_taken");
assert.equal(await errCode(api("POST", `${T}/dirs`, { path: "nope/x" }, { expect: 404 })), "not_found");
assert.equal(await errCode(api("POST", `${T}/dirs`, { path: "a/../b", parents: true }, { expect: 400 })), "bad_request");
assert.equal(await errCode(api("POST", `${T}/dirs`, { path: Array(17).fill("d").join("/"), parents: true }, { expect: 400 })), "bad_request");
const dirB = await api("GET", `${T}/stat?path=a/b`);
assert.deepEqual([dirB.kind, dirB.id], ["dir", dirC.parent_id]);
const dirX = await api("POST", `${T}/dirs`, { path: "x", parent_id: dirB.parent_id }, { expect: 201 });
assert.equal(dirX.path, "a/x");
// The same name lives in several directories; a file and a directory cannot share one.
const deep = await upload(tp.id, "notes.txt", Buffer.from("deep"), { parent_id: dirC.id });
assert.deepEqual([deep.kind, deep.parent_id, deep.path], ["file", dirC.id, "a/b/c/notes.txt"]);
const top = await upload(tp.id, "notes.txt", Buffer.from("top!!"));
assert.deepEqual([top.parent_id, top.path], [null, "notes.txt"]);
await upload(tp.id, "z.txt", Buffer.from("zz"), { parent_id: dirB.id });
assert.equal(await errCode(api("POST", `${T}/uploads`, { name: "a", size: 1, overwrite: true }, { expect: 409 })), "name_taken");
assert.equal(await errCode(api("POST", `${T}/uploads`, { name: "f", size: 1, parent_id: deep.id }, { expect: 404 })), "not_found");
assert.equal(await errCode(api("POST", `${T}/dirs`, { path: "notes.txt/sub", parents: true }, { expect: 409 })), "name_taken");
assert.equal((await upload(tp.id, "notes.txt", Buffer.from("deeper"), { parent_id: dirC.id, overwrite: true })).path, "a/b/c/notes.txt");
assert.equal((await fetchBytes((await api("GET", `/api/blobs/${(await api("GET", `${T}/stat?path=a/b/c/notes.txt`)).id}/download`)).url)).data.toString(), "deeper");
assert.equal(await errCode(api("GET", `/api/blobs/${dirC.id}/download`, undefined, { expect: 400 })), "bad_request");
// Listings: a directory (directories first) by path or id, and all files of the project.
const inB = await api("GET", `${T}/blobs?path=a/b&sort=name&order=asc`);
assert.deepEqual(inB.blobs.map((b) => [b.kind, b.path]), [["dir", "a/b/c"], ["file", "a/b/z.txt"]]);
assert.deepEqual([inB.dir.id, inB.dir.path, inB.dir.parents.map((d) => d.name), inB.total], [dirB.id, "a/b", ["a"], undefined]);
const inRoot = await api("GET", `${T}/blobs?path=/&sort=name&order=asc&limit=1`);
assert.deepEqual([inRoot.dir, inRoot.blobs.map((b) => b.name)], [{ id: null, path: "", parents: [] }, ["a"]]);
const inRoot2 = await api("GET", `${T}/blobs?path=&sort=name&order=asc&limit=1&cursor=${encodeURIComponent(inRoot.next_cursor)}`);
assert.deepEqual([inRoot2.blobs.map((b) => b.name), inRoot2.next_cursor], [["notes.txt"], null]);
assert.deepEqual((await api("GET", `${T}/blobs?parent_id=${dirC.id}`)).blobs.map((b) => b.name), ["notes.txt"]);
assert.equal(await errCode(api("GET", `${T}/blobs?path=a/nope`, undefined, { expect: 404 })), "not_found");
const allFiles = await api("GET", `${T}/blobs?sort=name&order=asc`);
assert.deepEqual([allFiles.blobs.map((b) => b.path).sort(), allFiles.total, allFiles.dir], [["a/b/c/notes.txt", "a/b/z.txt", "notes.txt"], 3, undefined]);
assert.equal((await api("GET", T)).blob_count, 3);
// Move and rename: one row, whatever the directory holds.
assert.equal((await api("PATCH", `/api/blobs/${dirC.id}`, { parent_id: dirX.id, name: "moved" })).path, "a/x/moved");
assert.equal((await api("GET", `/api/blobs/${deep.id}`, undefined, { expect: 404 }))?.error.code, "not_found"); // replaced by the overwrite
assert.equal((await api("GET", `${T}/stat?path=a/x/moved/notes.txt`)).size, 6);
assert.equal(await errCode(api("GET", `${T}/stat?path=a/b/c/notes.txt`, undefined, { expect: 404 })), "not_found");
assert.equal(await errCode(api("PATCH", `/api/blobs/${dirX.id}`, { parent_id: dirC.id }, { expect: 400 })), "bad_request"); // into itself
assert.equal(await errCode(api("PATCH", `/api/blobs/${top.id}`, { name: "a" }, { expect: 409 })), "name_taken");
assert.deepEqual(await api("POST", `${T}/blobs/move`, { ids: [top.id, dirX.id], parent_id: dirB.id }), { moved: 2 });
assert.deepEqual((await api("GET", `${T}/blobs?path=a/b&sort=name&order=asc`)).blobs.map((b) => b.path), ["a/b/x", "a/b/notes.txt", "a/b/z.txt"]);
assert.equal((await api("PATCH", `/api/blobs/${top.id}`, { parent_id: null })).path, "notes.txt");
// Sharing a directory: browsed a directory at a time, never above it; paths are relative to it.
const dshare = await api("POST", "/api/shares", { project_id: tp.id, blob_id: dirB.id }, { expect: 201 });
assert.deepEqual([dshare.blob_kind, dshare.blob_name, dshare.blob_path, dshare.download_url], ["dir", "b", "a/b", null]);
const dpub = await api("GET", `/api/public/shares/${dshare.token}`, undefined, { auth: null });
assert.deepEqual([dpub.share.kind, dpub.share.name, dpub.share.file_count, dpub.dir], ["dir", "b", null, { id: null, path: "", parents: [] }]);
assert.deepEqual(dpub.blobs.map((b) => [b.kind, b.path]), [["dir", "x"], ["file", "z.txt"]]);
const dsub = await api("GET", `/api/public/shares/${dshare.token}?parent_id=${dirC.id}`, undefined, { auth: null });
assert.deepEqual([dsub.dir.path, dsub.dir.parents.map((d) => d.name), dsub.blobs.map((b) => b.path)], ["x/moved", ["x"], ["x/moved/notes.txt"]]);
const dirA = await api("GET", `${T}/stat?path=a`);
assert.equal(await errCode(api("GET", `/api/public/shares/${dshare.token}?parent_id=${dirA.id}`, undefined, { auth: null, expect: 404 })), "not_found");
const inShare = dsub.blobs[0];
const viaDir = await api("GET", `/api/public/shares/${dshare.token}/blobs/${inShare.id}/download`, undefined, { auth: null });
assert.equal((await fetchBytes(viaDir.url)).data.toString(), "deeper");
assert.equal(await errCode(api("GET", `/api/public/shares/${dshare.token}/blobs/${top.id}/download`, undefined, { auth: null, expect: 404 })), "not_found");
assert.equal(await errCode(api("GET", `/api/public/shares/${dshare.token}/blobs/${dirC.id}/download`, undefined, { auth: null, expect: 404 })), "not_found");
const dlinks = (await (await viaLink(`/s/${dshare.token}`)).text()).trim().split("\n");
assert.deepEqual(dlinks, [`${BASE}/s/${dshare.token}/z.txt`, `${BASE}/s/${dshare.token}/x/moved/notes.txt`]);
const dvia = await viaLink(new URL(dlinks[1]).pathname);
assert.equal(dvia.status, 302);
assert.equal((await fetchBytes(dvia.headers.get("location"))).data.toString(), "deeper");
assert.equal((await viaLink(`/s/${dshare.token}/x/moved`)).status, 404);
assert.equal((await viaLink(`/s/${dshare.token}/notes.txt`)).status, 404);
// A project share covers every level too.
const pshare = await api("POST", "/api/shares", { project_id: tp.id }, { expect: 201 });
assert.equal((await viaLink(`/s/${pshare.token}/a/b/z.txt`)).status, 302);
assert.deepEqual((await api("GET", `/api/public/shares/${pshare.token}`, undefined, { auth: null })).blobs.map((b) => b.path), ["a", "notes.txt"]);
// An upload link into a directory.
assert.equal(await errCode(api("POST", "/api/shares", { project_id: tp.id, mode: "upload", blob_id: top.id }, { expect: 400 })), "bad_request");
const dup = await api("POST", "/api/shares", { project_id: tp.id, mode: "upload", blob_id: dirX.id }, { expect: 201 });
assert.deepEqual([(await api("GET", `/api/public/shares/${dup.token}`, undefined, { auth: null })).share.kind, dup.blob_path], ["dir", "a/b/x"]);
assert.deepEqual(await shareUpload(dup.token, null, "moved", Buffer.from("drop")), { name: "moved (1)", size: 4 }); // a directory has the name
assert.equal((await api("GET", `${T}/stat?path=${encodeURIComponent("a/b/x/moved (1)")}`)).via_inbox, true);
// Deleting a directory takes everything below it, its share links and its usage.
const before = await api("GET", T);
assert.deepEqual([before.blob_count, before.used_bytes], [4, 6 + 5 + 2 + 4]);
assert.deepEqual(await api("POST", `${T}/blobs/delete`, { ids: [dirX.id] }), { deleted: 1 });
assert.equal(await errCode(api("GET", `${T}/stat?path=a/b/x/moved/notes.txt`, undefined, { expect: 404 })), "not_found");
assert.equal(await errCode(api("GET", `/api/public/shares/${dup.token}`, undefined, { auth: null, expect: 404 })), "not_found");
const after = await api("GET", T);
assert.deepEqual([after.blob_count, after.used_bytes], [2, 5 + 2]);
await api("DELETE", `/api/blobs/${dirA.id}`, undefined, { expect: 204 });
assert.equal(await errCode(api("GET", `/api/public/shares/${dshare.token}`, undefined, { auth: null, expect: 404 })), "not_found");
assert.deepEqual((await api("GET", `${T}/blobs?path=`)).blobs.map((b) => b.name), ["notes.txt"]);
assert.equal((await api("GET", T)).used_bytes, 5);
step("directories: mkdir -p, uploads, listings by path, move/rename, directory shares and upload links, recursive delete");

const share2 = await api("POST", "/api/shares", { project_id: project.id, password: "s3cret", max_downloads: 1, expires_in: 3600 }, { expect: 201 });
assert.equal(share2.has_password, true);
const locked = await api("GET", `/api/public/shares/${share2.token}`, undefined, { auth: null });
assert.equal(locked.share.locked, true);
assert.equal(locked.blobs, undefined);
assert.equal(await errCode(api("POST", `/api/public/shares/${share2.token}/unlock`, { password: "wrong" }, { auth: null, expect: 403 })), "invalid_password");
assert.equal(await errCode(api("GET", `/api/public/shares/${share2.token}/blobs/${b2.id}/download`, undefined, { auth: null, expect: 403 })), "invalid_password");
const lockedLink = await viaLink(`/s/${share2.token}/big.bin`);
assert.equal(lockedLink.status, 403);
assert.match(await lockedLink.text(), /password protected; open .*\/s\/\w+ in a browser \(invalid_password\)/);
const { access_token } = await api("POST", `/api/public/shares/${share2.token}/unlock`, { password: "s3cret" }, { auth: null });
const unlocked = await api("GET", `/api/public/shares/${share2.token}`, undefined, { auth: null, headers: { "x-share-access": access_token } });
assert.equal(unlocked.blobs.length, 2);
const unlockedList = await viaLink(`/s/${share2.token}?access_token=${access_token}`);
assert.match(await unlockedList.text(), new RegExp(`/s/${share2.token}/big\\.bin\\?access_token=`));
const r302 = await fetch(`${BASE}/api/public/shares/${share2.token}/blobs/${b2.id}/download?redirect=1&access_token=${access_token}`, { redirect: "manual" });
assert.equal(r302.status, 302);
assert.equal(await errCode(api("GET", `/api/public/shares/${share2.token}`, undefined, { auth: null, expect: 410 })), "share_exhausted");
assert.equal((await viaLink(`/s/${share2.token}/big.bin?access_token=${access_token}`)).status, 410);
step("password share: locked → unlock → download → exhausted after max_downloads (API and direct links)");

// OIDC: HS256 (no signing key in Authentik) and RS256 (signing key selected)
const idp = await startIdp();
assert.equal((await api("POST", "/api/admin/oidc/test", { issuer: idp.issuer })).ok, true);
const st = await api("PUT", "/api/admin/settings", {
  oidc: { enabled: true, issuer: idp.issuer, client_id: "blift", client_secret: "oidc-secret", admin_group: "blift-admins", button_label: "Authentik" },
});
assert.equal(st.oidc.client_secret_set, true);
assert.equal(st.oidc.client_secret, undefined);
assert.equal((await api("GET", "/api/info", undefined, { auth: null })).oidc_enabled, true);
const asUser = (session) => api("GET", "/api/auth/me", undefined, { auth: null, headers: { cookie: session } });

idp.user = { sub: "authentik-1", email: "alice@example.com", preferred_username: "alice", name: "Alice", groups: ["blift-admins"] };
const l1 = await oidcLogin("/projects");
assert.equal(l1.location, "/projects");
const alice = await asUser(l1.session);
assert.deepEqual([alice.user.username, alice.user.role, alice.user.oidc_linked], ["alice", "admin", true]);

idp.alg = "RS256";
idp.user = { sub: "authentik-2", email: "bob@example.com", preferred_username: "alice", name: "Bob", groups: [] };
const l2 = await oidcLogin("//evil.example");
assert.equal(l2.location, "/"); // open redirects are neutralised
const bob = await asUser(l2.session);
assert.deepEqual([bob.user.username, bob.user.role], ["alice-2", "user"]); // unique username, no admin group
assert.equal(bob.user.quota_bytes, 10 * 1024 ** 3);

idp.user = { sub: "authentik-3", email: "ADMIN@example.com", preferred_username: "root", groups: [] };
const linked = await asUser((await oidcLogin()).session);
assert.deepEqual([linked.user.username, linked.user.id], ["admin", me.user.id]); // linked by email to the local admin
idp.close();
step("OIDC login: HS256 + RS256 ID tokens, PKCE, auto-register, admin group, email linking");

// CLI device flow
const dev = await api("POST", "/api/cli/login", { client_name: "smoke on ci" }, { auth: null });
assert.match(dev.user_code, /^[A-Z]{4}-[A-Z]{4}$/);
assert.equal(await errCode(api("POST", "/api/cli/login/poll", { device_code: dev.device_code }, { auth: null, expect: 400 })), "authorization_pending");
const pending = await api("GET", `/api/cli/login/${dev.user_code}`);
assert.equal(pending.client_name, "smoke on ci");
await api("POST", `/api/cli/login/${dev.user_code}/approve`, undefined, { expect: 204 });
const tok = await api("POST", "/api/cli/login/poll", { device_code: dev.device_code }, { auth: null });
assert.match(tok.token, /^blift_/);
assert.equal(await errCode(api("POST", "/api/cli/login/poll", { device_code: dev.device_code }, { auth: null, expect: 400 })), "expired_token");
const viaToken = await api("GET", "/api/projects", undefined, { auth: tok.token });
assert.deepEqual(viaToken.projects.map((p) => p.name).sort(), ["demo", "elsewhere", "listing", "tree"]);
step("CLI device login (pending → approved → token, single use)");

// API keys: unattended CLI logins. Single use, unlimited, linked sessions, revocation.
const k1 = await api("POST", "/api/auth/api-keys", { name: "deploy", max_uses: 1, expires_in: 3600 }, { expect: 201 });
assert.match(k1.key, /^bliftk_[0-9A-Za-z]{32}$/);
assert.equal(k1.prefix, k1.key.slice(0, 11));
const viaKey = await api("POST", "/api/cli/login/api-key", { api_key: k1.key, client_name: "smoke key" }, { auth: null });
assert.match(viaKey.token, /^blift_/);
assert.equal(viaKey.user.username, "admin");
await api("GET", "/api/projects", undefined, { auth: viaKey.token });
assert.equal(await errCode(api("POST", "/api/cli/login/api-key", { api_key: k1.key }, { auth: null, expect: 401 })), "invalid_api_key");
assert.equal(await errCode(api("POST", "/api/cli/login/api-key", { api_key: "bliftk_nope" }, { auth: null, expect: 401 })), "invalid_api_key");
assert.equal(await errCode(api("POST", "/api/auth/api-keys", { name: "x", max_uses: 0 }, { expect: 400 })), "bad_request");
const k2 = await api("POST", "/api/auth/api-keys", { name: "fleet" }, { expect: 201 });
assert.deepEqual([k2.max_uses, k2.expires_at, k2.session_ttl], [null, null, 90 * 86400]);
const fleetTokens = [];
for (const host of ["build-1", "build-2"])
  fleetTokens.push((await api("POST", "/api/cli/login/api-key", { api_key: k2.key, client_name: host }, { auth: null })).token);
const fleet = (await api("GET", "/api/auth/api-keys")).api_keys.find((k) => k.id === k2.id);
assert.deepEqual([fleet.use_count, fleet.session_count, fleet.key], [2, 2, undefined]);
const keySessions = (await api("GET", "/api/auth/sessions")).sessions.filter((x) => x.api_key_name === "fleet");
assert.deepEqual(keySessions.map((x) => x.name).sort(), ["build-1", "build-2"]);
await api("DELETE", `/api/auth/api-keys/${k1.id}`, undefined, { expect: 204 }); // its session stays
await api("GET", "/api/auth/me", undefined, { auth: viaKey.token });
await api("DELETE", `/api/auth/api-keys/${k2.id}?revoke_sessions=1`, undefined, { expect: 204 });
for (const t of fleetTokens) assert.equal(await errCode(api("GET", "/api/auth/me", undefined, { auth: t, expect: 401 })), "unauthorized");
assert.equal(await errCode(api("POST", "/api/cli/login/api-key", { api_key: k2.key }, { auth: null, expect: 401 })), "invalid_api_key");
assert.equal(await errCode(api("DELETE", `/api/auth/api-keys/${k2.id}`, undefined, { expect: 404 })), "not_found");
// Sign-in lifetime: a day, or until revoked (survives GC, ends with the key's revocation below).
const kDay = await api("POST", "/api/auth/api-keys", { name: "day", session_ttl: 86400 }, { expect: 201 });
const kForever = await api("POST", "/api/auth/api-keys", { name: "forever", session_ttl: null, max_uses: 1 }, { expect: 201 });
assert.deepEqual([kDay.session_ttl, kForever.session_ttl], [86400, null]);
assert.equal(await errCode(api("POST", "/api/auth/api-keys", { name: "x", session_ttl: 60 }, { expect: 400 })), "bad_request");
await api("POST", "/api/cli/login/api-key", { api_key: kDay.key, client_name: "day-host" }, { auth: null });
const forever = await api("POST", "/api/cli/login/api-key", { api_key: kForever.key, client_name: "forever-host" }, { auth: null });
const lifetimes = Object.fromEntries((await api("GET", "/api/auth/sessions")).sessions.map((x) => [x.name, x.expires_at]));
assert.equal(lifetimes["forever-host"], null);
assert.ok(Math.abs(lifetimes["day-host"] - (Date.now() + 86_400_000)) < 120_000, `day session expires_at ${lifetimes["day-host"]}`);
step("API keys: single use, unlimited, sessions linked to the key, delete signs them out, sign-in lifetime");

// Upload links (inboxes): shares with mode "upload" take anonymous uploads into a project.
const ib = await api("POST", "/api/projects", { name: "inbox", description: "drop files here" }, { expect: 201 });
assert.ok(!("inbox_enabled" in ib) && !("inbox_url" in ib), "projects no longer have an inbox switch");
await api("POST", `/api/projects/${ib.id}/members`, { user: "alice-2", role: "viewer" }, { expect: 201 });
const asBob = (method, path, body, expect) => api(method, path, body, { auth: null, headers: { cookie: l2.session }, expect });
assert.equal(await errCode(asBob("POST", "/api/shares", { project_id: ib.id, mode: "upload" }, 403)), "forbidden"); // editors and up
assert.equal(await errCode(api("POST", "/api/shares", { project_id: ib.id, mode: "both" }, { expect: 400 })), "bad_request");
assert.equal(await errCode(api("POST", "/api/shares", { project_id: ib.id, mode: "upload", blob_id: "x" }, { expect: 404 })), "not_found");
const up = await api("POST", "/api/shares", { project_id: ib.id, mode: "upload", password: "letmein", max_downloads: 5 }, { expect: 201 });
assert.deepEqual([up.mode, up.blob_id, up.download_url, up.max_downloads, up.max_uploads, up.upload_count], ["upload", null, null, null, null, 0]);
const ibToken = up.token;
// Locked until unlocked; uploaders learn the project and the limits, never its files.
const ibLocked = await api("GET", `/api/public/shares/${ibToken}`, undefined, { auth: null });
assert.deepEqual([ibLocked.share.mode, ibLocked.share.locked, ibLocked.blobs], ["upload", true, undefined]);
assert.equal(await errCode(api("POST", `/api/public/shares/${ibToken}/uploads`, { name: "x", size: 1 }, { auth: null, expect: 403 })), "invalid_password");
const { access_token: ibAccess } = await api("POST", `/api/public/shares/${ibToken}/unlock`, { password: "letmein" }, { auth: null });
const ibHeaders = { "x-share-access": ibAccess };
const ibInfo = await api("GET", `/api/public/shares/${ibToken}`, undefined, { auth: null, headers: ibHeaders });
assert.deepEqual(
  [ibInfo.share.name, ibInfo.share.description, ibInfo.share.creator, ibInfo.share.locked, ibInfo.blobs, ibInfo.share.file_count],
  ["inbox", "drop files here", "admin", false, undefined, undefined],
);
const report = Buffer.from("quarterly numbers");
assert.deepEqual(await shareUpload(ibToken, ibAccess, "report.pdf", report), { name: "report.pdf", size: report.length });
assert.equal((await shareUpload(ibToken, ibAccess, "report.pdf", report)).name, "report (1).pdf"); // never replaces
assert.equal((await shareUpload(ibToken, ibAccess, "big.bin", big)).size, big.length); // multipart
const ibFiles = (await api("GET", `/api/projects/${ib.id}/blobs?sort=name&order=asc`)).blobs;
assert.deepEqual(ibFiles.map((b) => [b.name, b.via_inbox, b.uploader]), [["big.bin", true, null], ["report (1).pdf", true, null], ["report.pdf", true, null]]);
assert.equal((await api("GET", `/api/projects/${ib.id}`)).used_bytes, 2 * report.length + big.length);
const upNow = (await api("GET", `/api/shares?project_id=${ib.id}`)).shares.find((x) => x.id === up.id);
assert.deepEqual([upNow.upload_count, upNow.upload_bytes, upNow.download_count], [3, 2 * report.length + big.length, 0]);
// Nothing to download through it, in the API or for wget.
assert.equal(await errCode(api("GET", `/api/public/shares/${ibToken}/blobs/${ibFiles[0].id}/download`, undefined, { auth: null, headers: ibHeaders, expect: 404 })), "not_found");
assert.equal((await viaLink(`/s/${ibToken}`)).status, 404);
// An upload token only works for its own upload.
const ia = await api("POST", `/api/public/shares/${ibToken}/uploads`, { name: "a.txt", size: 1 }, { auth: null, headers: ibHeaders, expect: 201 });
const ibb = await api("POST", `/api/public/shares/${ibToken}/uploads`, { name: "b.txt", size: 1 }, { auth: null, headers: ibHeaders, expect: 201 });
const wrongTok = { "x-upload-token": ibb.upload_token };
assert.equal(await errCode(api("POST", `/api/public/shares/${ibToken}/uploads/${ia.blob_id}/complete`, {}, { auth: null, headers: wrongTok, expect: 404 })), "not_found");
await api("DELETE", `/api/public/shares/${ibToken}/uploads/${ia.blob_id}`, undefined, { auth: null, headers: { "x-upload-token": ia.upload_token }, expect: 204 });
// Limits per link: a file larger than the size left is refused when it starts; uploads that race
// for the last slot both start, but only one completes; then the link is used up.
const lim = await api("POST", "/api/shares", { project_id: ib.id, mode: "upload", max_uploads: 1, max_upload_bytes: 2 * report.length - 1 }, { expect: 201 });
assert.equal(await errCode(api("POST", `/api/public/shares/${lim.token}/uploads`, { name: "huge.bin", size: 2 * report.length }, { auth: null, expect: 413 })), "upload_too_large");
const race = [];
for (const name of ["one.txt", "two.txt"]) {
  const init = await api("POST", `/api/public/shares/${lim.token}/uploads`, { name, size: report.length }, { auth: null, expect: 201 });
  assert.equal((await fetch(init.url, { method: "PUT", body: report })).status, 200);
  race.push(init);
}
const complete = (init, expect) =>
  api("POST", `/api/public/shares/${lim.token}/uploads/${init.blob_id}/complete`, {}, { auth: null, headers: { "x-upload-token": init.upload_token }, expect });
assert.deepEqual(await complete(race[0]), { name: "one.txt", size: report.length });
assert.equal(await errCode(complete(race[1], 410)), "share_exhausted");
assert.equal(await errCode(api("GET", `/api/public/shares/${lim.token}`, undefined, { auth: null, expect: 410 })), "share_exhausted");
assert.equal(await errCode(api("POST", `/api/public/shares/${lim.token}/uploads`, { name: "three.txt", size: 1 }, { auth: null, expect: 410 })), "share_exhausted");
// Deleting the link stops it at once, uploads under way too (b.txt has a valid upload token).
await api("DELETE", `/api/shares/${up.id}`, undefined, { expect: 204 });
assert.equal(await errCode(api("GET", `/api/public/shares/${ibToken}`, undefined, { auth: null, expect: 404 })), "not_found");
assert.equal(await errCode(api("POST", `/api/public/shares/${ibToken}/uploads/${ibb.blob_id}/complete`, {}, { auth: null, headers: wrongTok, expect: 404 })), "not_found");
step("upload links: password, single + multipart, auto-rename, nothing to download, upload tokens, file/size limits, delete");

// WebDAV: Basic sign-in with a WebDAV password, the requests Zotero and OmniFocus make.
const wp = await api("POST", "/api/projects", { name: "dav" }, { expect: 201 });
assert.deepEqual([wp.webdav_enabled, wp.webdav_url], [false, `${BASE}/dav/admin/dav/`]);
const davPw = await api("POST", "/api/auth/dav-passwords", { name: "zotero" }, { expect: 201 });
assert.match(davPw.password, /^bliftd_[0-9A-Za-z]{24}$/);
assert.deepEqual([davPw.username, davPw.generated, davPw.project_id, davPw.readonly], ["admin", true, null, false]);
const basic = (user, pw) => `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}`;
let davAuth = basic("admin", davPw.password);
let davUploads = 0;
let davBytes = 0;
const dav = async (method, path, { body, headers = {}, auth = davAuth } = {}) => {
  const res = await fetch(`${BASE}/dav${path}`, { method, body, headers: { ...(auth ? { authorization: auth } : {}), ...headers }, redirect: "manual" });
  if (method === "PUT" && res.status < 300) {
    davUploads++;
    davBytes += body?.length ?? 0;
  }
  return res;
};
const hrefs = (xml) => [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map((m) => m[1]);
const prop = (xml, name) => xml.match(new RegExp(`<D:${name}>([^<]*)</D:${name}>`))?.[1];
// Sign-in: OPTIONS needs none; anything else answers 401 with a Basic davChallenge.
const davOpts = await dav("OPTIONS", "/admin/dav/", { auth: null });
assert.deepEqual([davOpts.status, davOpts.headers.get("dav")], [200, "1, 2"]);
const davChallenge = await dav("PROPFIND", "/admin/dav/", { auth: null, headers: { depth: "0" } });
assert.equal(davChallenge.status, 401);
assert.match(davChallenge.headers.get("www-authenticate"), /^Basic realm=/);
assert.equal((await dav("PROPFIND", "/", { auth: basic("admin", "password123"), headers: { depth: "0" } })).status, 401); // not the account password
assert.equal((await dav("PROPFIND", "/", { auth: basic("admin", "bliftd_wrongwrongwrongwrongwron"), headers: { depth: "0" } })).status, 401);
// A project is not there until its owner turns WebDAV on.
assert.equal((await dav("PROPFIND", "/admin/dav/", { headers: { depth: "0" } })).status, 404);
assert.equal((await api("PATCH", `/api/projects/${wp.id}`, { webdav_enabled: true })).webdav_enabled, true);
assert.deepEqual(hrefs(await (await dav("PROPFIND", "/", { headers: { depth: "1" } })).text()), ["/dav/", "/dav/admin/"]);
assert.deepEqual(hrefs(await (await dav("PROPFIND", "/admin/", { headers: { depth: "1" } })).text()), ["/dav/admin/", "/dav/admin/dav/"]);
assert.equal((await dav("PROPFIND", "/admin/dav/")).status, 403); // Depth: infinity
// Zotero's "Verify Server", then a sync: MKCOL must answer 201, a missing file 404.
const Z = "/admin/dav/zotero";
assert.equal((await dav("PROPFIND", `${Z}/`, { headers: { depth: "0" } })).status, 404);
assert.equal((await dav("PROPFIND", "/admin/dav/", { headers: { depth: "0" } })).status, 207);
assert.equal((await dav("MKCOL", `${Z}/`)).status, 201);
assert.equal((await dav("MKCOL", `${Z}/`)).status, 405);
assert.equal((await dav("MKCOL", `${Z}/a/b/`)).status, 409);
const zroot = await dav("PROPFIND", `${Z}/`, { headers: { depth: "0", "content-type": "text/xml; charset=utf-8" }, body: "<propfind xmlns='DAV:'><prop><getcontentlength/></prop></propfind>" });
assert.equal(zroot.status, 207);
assert.match(zroot.headers.get("content-type"), /xml/);
assert.equal((await dav("GET", `${Z}/nonexistent.prop`)).status, 404);
assert.equal((await dav("PUT", `${Z}/zotero-test-file.prop`, { body: Buffer.from(" ") })).status, 201);
const zget = await dav("GET", `${Z}/zotero-test-file.prop`);
assert.deepEqual([zget.status, await zget.text()], [200, " "]);
assert.equal((await dav("DELETE", `${Z}/zotero-test-file.prop`)).status, 204);
assert.equal((await dav("DELETE", `${Z}/zotero-test-file.prop`)).status, 404);
const davZip = randomBytes(300_000);
const propXml = Buffer.from('<properties version="1"><mtime>1700000000000</mtime><hash>abc</hash></properties>');
assert.equal((await dav("PUT", `${Z}/ABCD2345.zip`, { body: davZip, headers: { "content-type": "application/zip" } })).status, 201);
assert.equal((await dav("PUT", `${Z}/ABCD2345.prop`, { body: propXml, headers: { "content-type": "text/xml" } })).status, 201);
assert.equal((await dav("PUT", `${Z}/ABCD2345.prop`, { body: propXml, headers: { "content-type": "text/xml" } })).status, 204); // davReplaced
assert.ok(Buffer.from(await (await dav("GET", `${Z}/ABCD2345.zip`)).arrayBuffer()).equals(davZip));
const zlist = await (await dav("PROPFIND", `${Z}/`, { headers: { depth: "1" }, body: "<propfind xmlns='DAV:'><prop><getlastmodified/></prop></propfind>" })).text();
assert.deepEqual(hrefs(zlist), ["/dav/admin/dav/zotero/", "/dav/admin/dav/zotero/ABCD2345.prop", "/dav/admin/dav/zotero/ABCD2345.zip"]);
assert.ok(!Number.isNaN(Date.parse(prop(zlist, "getlastmodified"))));
// The files are ordinary files of the project.
assert.deepEqual((await api("GET", `/api/projects/${wp.id}/blobs?path=zotero&sort=name&order=asc`)).blobs.map((b) => [b.name, b.size]), [["ABCD2345.prop", propXml.length], ["ABCD2345.zip", davZip.length]]);
// GET: ETag, conditional requests, ranges; HEAD; bytes come back as they went in.
const davHead = await dav("HEAD", `${Z}/ABCD2345.zip`);
const davEtag = davHead.headers.get("etag");
assert.deepEqual([davHead.status, davHead.headers.get("content-length"), davHead.headers.get("content-type")], [200, String(davZip.length), "application/zip"]);
assert.equal((await dav("GET", `${Z}/ABCD2345.zip`, { headers: { "if-none-match": davEtag } })).status, 304);
const davRanged = await dav("GET", `${Z}/ABCD2345.zip`, { headers: { range: "bytes=10-19" } });
assert.deepEqual([davRanged.status, Buffer.from(await davRanged.arrayBuffer()).equals(davZip.subarray(10, 20))], [206, true]);
assert.equal((await dav("PUT", `${Z}/ABCD2345.zip`, { body: davZip, headers: { "if-match": '"stale"' } })).status, 412);
assert.equal((await dav("PUT", `${Z}/ABCD2345.zip`, { body: davZip, headers: { "if-none-match": "*" } })).status, 412);
assert.equal((await dav("PUT", `${Z}/ABCD2345.zip`, { body: davZip, headers: { "if-match": davEtag } })).status, 204);
assert.notEqual((await dav("HEAD", `${Z}/ABCD2345.zip`)).headers.get("etag"), davEtag); // a new upload, a new ETag
// A body too large to buffer is streamed to the storage (the 100 MiB file of the upload tests).
assert.equal((await dav("PUT", "/admin/dav/big.bin", { body: big })).status, 201);
assert.equal((await api("GET", `/api/projects/${wp.id}/stat?path=big.bin`)).size, big.length);
assert.equal(sha(Buffer.from(await (await dav("GET", "/admin/dav/big.bin")).arrayBuffer())), sha(big));
// OmniFocus (OmniDAV's conformance tests): names with spaces, MOVE and COPY with Overwrite, a
// Date header, and a collection's modification date following what happens in it.
const O = "/admin/dav/omni%20tests%20";
for (const d of ["", "/parent", "/parent/tmp", "/parent/doc", "/parent/tmp/doc"]) assert.equal((await dav("MKCOL", `${O}${d}/`)).status, 201);
await dav("PUT", `${O}/parent/doc/contents`, { body: Buffer.from("old") });
await dav("PUT", `${O}/parent/tmp/doc/contents`, { body: Buffer.from("new") });
const davBefore = await dav("PROPFIND", `${O}/parent/`, { headers: { depth: "0" } });
assert.ok(davBefore.headers.get("date"));
const modifiedBefore = prop(await davBefore.text(), "getlastmodified");
await new Promise((r) => setTimeout(r, 1100));
const abs = (p) => `${BASE}/dav${p}`;
const davReplaced = await dav("MOVE", `${O}/parent/tmp/doc/`, { headers: { destination: abs(`${O}/parent/doc/`), overwrite: "T" } });
assert.equal(davReplaced.status, 204);
assert.equal(await (await dav("GET", `${O}/parent/doc/contents`)).text(), "new");
const davAfter = await dav("PROPFIND", `${O}/parent/`, { headers: { depth: "0" } });
assert.ok(Date.parse(davAfter.headers.get("date")) > Date.parse(davBefore.headers.get("date")), "the Date header moves forward");
assert.notEqual(prop(await davAfter.text(), "getlastmodified"), modifiedBefore, "replacing a child changes the collection's date");
await dav("PUT", `${O}/a`, { body: Buffer.from("A") });
await dav("PUT", `${O}/b`, { body: Buffer.from("B") });
const davMoved = await dav("MOVE", `${O}/a`, { headers: { destination: abs(`${O}/c`), overwrite: "F" } });
assert.deepEqual([davMoved.status, davMoved.headers.get("location")], [201, "/dav/admin/dav/omni%20tests%20/c"]);
assert.equal((await dav("MOVE", `${O}/b`, { headers: { destination: abs(`${O}/c`), overwrite: "F" } })).status, 412);
assert.equal((await dav("MOVE", `${O}/b`, { headers: { destination: abs(`${O}/missing/file`), overwrite: "F" } })).status, 409);
assert.equal((await dav("MOVE", `${O}/b`, { headers: { destination: abs(`${O}/missing/deeper/file`), overwrite: "F" } })).status, 409);
assert.equal((await dav("MOVE", `${O}/parent/`, { headers: { destination: abs(`${O}/parent/doc/inside/`) } })).status, 400); // into itself
assert.equal((await dav("COPY", `${O}/c`, { headers: { destination: abs(`${O}/copy`), overwrite: "F" } })).status, 201);
assert.equal(await (await dav("GET", `${O}/copy`)).text(), "A");
assert.equal((await dav("COPY", `${O}/parent/`, { headers: { destination: abs(`${O}/parent2/`), overwrite: "F" } })).status, 201);
assert.equal(await (await dav("GET", `${O}/parent2/doc/contents`)).text(), "new");
assert.equal((await dav("COPY", `${O}/parent/`, { headers: { destination: abs(`${O}/parent2/`), overwrite: "F" } })).status, 412);
const gz = Buffer.from("1f8b0800000000000003cb48cdc9c907008628a61005000000", "hex"); // stays compressed
await dav("PUT", `${O}/file`, { body: gz });
const gzBack = await dav("GET", `${O}/file`);
assert.deepEqual([gzBack.headers.get("content-encoding"), Buffer.from(await gzBack.arrayBuffer()).equals(gz)], [null, true]);
assert.equal((await dav("DELETE", `${O}/`)).status, 204);
assert.equal((await dav("PROPFIND", `${O}/`, { headers: { depth: "0" } })).status, 404);
// Locks in name only, for Finder, Windows and Office: LOCK answers with a token (and creates an
// empty file for a free name), a refresh keeps the token, UNLOCK is accepted; nothing is refused.
const lockBody = '<?xml version="1.0"?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>mac</D:href></D:owner></D:lockinfo>';
const locked1 = await dav("LOCK", `${Z}/new.docx`, { body: lockBody, headers: { "content-type": "text/xml", timeout: "Second-600" } });
const lockToken = locked1.headers.get("lock-token");
const lockXml = await locked1.text();
assert.equal(locked1.status, 201);
assert.match(lockToken, /^<opaquelocktoken:[0-9a-f-]{36}>$/);
assert.ok(lockXml.includes(`<D:href>${lockToken.slice(1, -1)}</D:href>`) && lockXml.includes("<D:owner>mac</D:owner>") && lockXml.includes("/dav/admin/dav/zotero/new.docx"));
davUploads++; // the empty file
assert.equal((await dav("HEAD", `${Z}/new.docx`)).headers.get("content-length"), "0");
assert.equal((await dav("PUT", `${Z}/new.docx`, { body: Buffer.from("doc"), headers: { if: `(${lockToken})` } })).status, 204);
const relock = await dav("LOCK", `${Z}/new.docx`, { headers: { if: `(${lockToken})` } });
assert.deepEqual([relock.status, relock.headers.get("lock-token")], [200, lockToken]);
assert.equal((await dav("PUT", `${Z}/new.docx`, { body: Buffer.from("other") })).status, 204); // no token: still not refused
assert.equal((await dav("UNLOCK", `${Z}/new.docx`, { headers: { "lock-token": lockToken } })).status, 204);
assert.equal((await dav("UNLOCK", `${Z}/new.docx`)).status, 400);
assert.equal((await dav("LOCK", `${Z}/nope/x`, { body: lockBody })).status, 409);
assert.ok((await (await dav("PROPFIND", `${Z}/new.docx`, { headers: { depth: "0" } })).text()).includes("<D:supportedlock>"));
assert.equal((await dav("DELETE", `${Z}/new.docx`)).status, 204);
// Passwords: one the user chose, limited to a project and to reading; deleting one ends it.
assert.equal(await errCode(api("POST", "/api/auth/dav-passwords", { name: "short", password: "tooshort" }, { expect: 400 })), "bad_request");
const ro = await api("POST", "/api/auth/dav-passwords", { name: "reader", password: "correct horse battery", project_id: wp.id, readonly: true }, { expect: 201 });
assert.deepEqual([ro.password, ro.generated, ro.project_id, ro.readonly], [undefined, false, wp.id, true]);
const roAuth = basic("ADMIN", "correct horse battery"); // usernames are case-insensitive
assert.equal((await dav("GET", `${Z}/ABCD2345.prop`, { auth: roAuth })).status, 200);
assert.equal((await dav("PUT", `${Z}/x`, { auth: roAuth, body: Buffer.from("x") })).status, 403);
assert.equal((await dav("LOCK", `${Z}/x`, { auth: roAuth, body: lockBody })).status, 403);
assert.equal((await dav("DELETE", `${Z}/ABCD2345.prop`, { auth: roAuth })).status, 403);
assert.equal((await dav("GET", `${Z}/ABCD2345.prop`, { auth: basic("admin", "correct horse battery!") })).status, 401);
assert.deepEqual((await api("GET", "/api/auth/dav-passwords")).dav_passwords.map((d) => [d.name, d.project_name]), [["reader", "dav"], ["zotero", null]]);
await api("DELETE", `/api/auth/dav-passwords/${ro.id}`, undefined, { expect: 204 });
assert.equal((await dav("GET", `${Z}/ABCD2345.prop`, { auth: roAuth })).status, 401);
await api("PATCH", `/api/projects/${wp.id}`, { webdav_enabled: false });
assert.equal((await dav("PROPFIND", "/admin/dav/", { headers: { depth: "0" } })).status, 404);
step(`WebDAV: sign-in, Zotero's server check and sync, ranges and ETags, a streamed 100 MiB PUT, OmniFocus' MOVE/COPY checks (${davUploads} uploads)`);

// Members
const second = await api("POST", "/api/projects", { name: "demo2" }, { auth: tok.token, expect: 201 });
await api("DELETE", `/api/projects/${second.id}`, undefined, { auth: tok.token, expect: 204 });

// TOTP for the admin
const setup = await api("POST", "/api/auth/totp/setup");
assert.equal(await errCode(api("POST", "/api/auth/totp/enable", { code: "000000" }, { expect: 400 })), "invalid_code");
await api("POST", "/api/auth/totp/enable", { code: totp(setup.secret) }, { expect: 204 });
await api("POST", "/api/auth/logout", undefined, { expect: 204 });
cookie = "";
const login = await api("POST", "/api/auth/login", { username: "admin", password: "password123" });
assert.equal(login.mfa_required, true);
assert.equal(await errCode(api("GET", "/api/projects", undefined, { expect: 401 })), "mfa_required");
await api("POST", "/api/auth/mfa", { code: totp(setup.secret) });
await api("GET", "/api/projects");
step("admin TOTP: enable → password login requires code → session upgraded");

// Delete + GC
await api("DELETE", `/api/blobs/${b2.id}`, undefined, { expect: 204 });
const gc1 = await api("POST", "/api/admin/gc", {});
assert.ok(gc1.result.objects_deleted >= 2, JSON.stringify(gc1.result)); // big.bin + replaced hello v1
assert.equal((await fetch(d2.url)).status, 404, "deleted object should be gone from S3");
await api("DELETE", `/api/projects/${project.id}`, undefined, { expect: 204 });
const gc2 = await api("POST", "/api/admin/gc", {});
assert.equal(gc1.result.projects_purged, 1); // the empty demo2 project
assert.equal(gc2.result.projects_purged, 1);
step(`GC removes objects (${gc1.result.objects_deleted}) and purges deleted projects`);

// A sign-in "until revoked" outlives GC and ends only when revoked (here: with its key).
await api("GET", "/api/auth/me", undefined, { auth: forever.token });
await api("DELETE", `/api/auth/api-keys/${kForever.id}?revoke_sessions=1`, undefined, { expect: 204 });
assert.equal(await errCode(api("GET", "/api/auth/me", undefined, { auth: forever.token, expect: 401 })), "unauthorized");
step("an API-key sign-in without expiry survives GC until revoked");

await api("DELETE", `/api/projects/${lp.id}`, undefined, { expect: 204 }); // releases its usage at once
await api("DELETE", `/api/projects/${ib.id}`, undefined, { expect: 204 });
await api("DELETE", `/api/projects/${elsewhere.id}`, undefined, { expect: 204 });
await api("DELETE", `/api/projects/${tp.id}`, undefined, { expect: 204 });
await api("DELETE", `/api/projects/${wp.id}`, undefined, { expect: 204 });
const treeBytes = 4 + 5 + 2 + 6 + 4; // the five uploads of the directories section
const inboxBytes = 3 * report.length + big.length; // report.pdf, report (1).pdf, big.bin, one.txt
const stats = await api("GET", "/api/admin/stats?days=7");
assert.equal(stats.series.length, 7);
const today = stats.series.at(-1);
const listingBytes = names.reduce((n, x) => n + Buffer.byteLength(x), 0);
assert.ok(
  today.requests > 20 &&
    today.uploads === 3 + names.length + 4 + 5 + davUploads &&
    today.upload_bytes === small.length + big.length + small2.length + listingBytes + inboxBytes + treeBytes + davBytes,
  JSON.stringify(today),
);
const users = await api("GET", "/api/admin/users");
assert.ok(users.users.every((u) => u.used_bytes === 0), "usage released after deletes");
assert.equal(users.total, 3);
step(`admin stats (today: ${today.requests} requests, ${today.uploads} uploads, ${today.downloads} downloads)`);

console.log("\nall smoke checks passed");
