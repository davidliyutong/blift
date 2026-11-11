// End-to-end smoke test against a running server and a real S3 bucket.
//
//   BASE=http://localhost:8787 BOOTSTRAP_SECRET=... \
//   S3_ENDPOINT=http://localhost:19000 S3_BUCKET=blift-test S3_ACCESS_KEY=... S3_SECRET_KEY=... \
//   node test/smoke.mjs
//
// Expects a fresh database (it performs the one-off bootstrap). `make smoke` sets it all up.
import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes } from "node:crypto";
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

/** Anonymous upload through a project inbox (single or multipart); returns {name, size}. */
async function inboxUpload(token, name, data) {
  const init = await api("POST", `/api/public/inbox/${token}/uploads`, { name, size: data.length }, { auth: null, expect: 201 });
  const headers = { "x-upload-token": init.upload_token };
  if (init.mode === "single") {
    const r = await fetch(init.url, { method: "PUT", body: data });
    assert.equal(r.status, 200, `PUT single → ${r.status} ${await r.text()}`);
  } else {
    const nums = Array.from({ length: init.part_count }, (_, i) => i + 1);
    const { urls } = await api("POST", `/api/public/inbox/${token}/uploads/${init.blob_id}/parts`, { part_numbers: nums }, { auth: null, headers });
    await Promise.all(
      nums.map(async (n) => {
        const r = await fetch(urls[n], { method: "PUT", body: data.subarray((n - 1) * init.part_size, n * init.part_size) });
        assert.equal(r.status, 200, `PUT part ${n} → ${r.status}`);
      }),
    );
  }
  return api("POST", `/api/public/inbox/${token}/uploads/${init.blob_id}/complete`, {}, { auth: null, headers });
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
step(`listing: cursor pages, prefix, exact names, paged public share (${names.length} files)`);

const share2 = await api("POST", "/api/shares", { project_id: project.id, password: "s3cret", max_downloads: 1, expires_in: 3600 }, { expect: 201 });
assert.equal(share2.has_password, true);
const locked = await api("GET", `/api/public/shares/${share2.token}`, undefined, { auth: null });
assert.equal(locked.share.locked, true);
assert.equal(locked.blobs, undefined);
assert.equal(await errCode(api("POST", `/api/public/shares/${share2.token}/unlock`, { password: "wrong" }, { auth: null, expect: 403 })), "invalid_password");
assert.equal(await errCode(api("GET", `/api/public/shares/${share2.token}/blobs/${b2.id}/download`, undefined, { auth: null, expect: 403 })), "invalid_password");
const { access_token } = await api("POST", `/api/public/shares/${share2.token}/unlock`, { password: "s3cret" }, { auth: null });
const unlocked = await api("GET", `/api/public/shares/${share2.token}`, undefined, { auth: null, headers: { "x-share-access": access_token } });
assert.equal(unlocked.blobs.length, 2);
const r302 = await fetch(`${BASE}/api/public/shares/${share2.token}/blobs/${b2.id}/download?redirect=1&access_token=${access_token}`, { redirect: "manual" });
assert.equal(r302.status, 302);
assert.equal(await errCode(api("GET", `/api/public/shares/${share2.token}`, undefined, { auth: null, expect: 410 })), "share_exhausted");
step("password share: locked → unlock → download → exhausted after max_downloads");

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
assert.deepEqual(viaToken.projects.map((p) => p.name).sort(), ["demo", "elsewhere", "listing"]);
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

// Inbox: anonymous uploads into a project (off by default, link visible to editors and owners).
const ib = await api("POST", "/api/projects", { name: "inbox", description: "drop files here" }, { expect: 201 });
assert.deepEqual([ib.inbox_enabled, ib.inbox_url], [false, null]);
const ibOn = await api("PATCH", `/api/projects/${ib.id}`, { inbox_enabled: true });
assert.match(ibOn.inbox_url, /\/i\/[0-9A-Za-z]{12}$/);
let ibToken = ibOn.inbox_url.split("/i/")[1];
const ibInfo = await api("GET", `/api/public/inbox/${ibToken}`, undefined, { auth: null });
assert.deepEqual(ibInfo.inbox, { name: "inbox", description: "drop files here", owner: "admin" });
const report = Buffer.from("quarterly numbers");
assert.deepEqual(await inboxUpload(ibToken, "report.pdf", report), { name: "report.pdf", size: report.length });
assert.equal((await inboxUpload(ibToken, "report.pdf", report)).name, "report (1).pdf"); // never replaces
assert.equal((await inboxUpload(ibToken, "big.bin", big)).size, big.length); // multipart
const ibFiles = (await api("GET", `/api/projects/${ib.id}/blobs?sort=name&order=asc`)).blobs;
assert.deepEqual(ibFiles.map((b) => [b.name, b.via_inbox, b.uploader]), [["big.bin", true, null], ["report (1).pdf", true, null], ["report.pdf", true, null]]);
assert.equal((await api("GET", `/api/projects/${ib.id}`)).used_bytes, 2 * report.length + big.length);
// An upload token only works for its own upload.
const ia = await api("POST", `/api/public/inbox/${ibToken}/uploads`, { name: "a.txt", size: 1 }, { auth: null, expect: 201 });
const ibb = await api("POST", `/api/public/inbox/${ibToken}/uploads`, { name: "b.txt", size: 1 }, { auth: null, expect: 201 });
const wrongTok = { "x-upload-token": ibb.upload_token };
assert.equal(await errCode(api("POST", `/api/public/inbox/${ibToken}/uploads/${ia.blob_id}/complete`, {}, { auth: null, headers: wrongTok, expect: 404 })), "not_found");
await api("DELETE", `/api/public/inbox/${ibToken}/uploads/${ia.blob_id}`, undefined, { auth: null, headers: { "x-upload-token": ia.upload_token }, expect: 204 });
// Viewers know the inbox is on but do not get its link, and cannot change it.
await api("POST", `/api/projects/${ib.id}/members`, { user: "alice-2", role: "viewer" }, { expect: 201 });
const asBob = (method, path, body, expect) => api(method, path, body, { auth: null, headers: { cookie: l2.session }, expect });
const ibViewer = await asBob("GET", `/api/projects/${ib.id}`);
assert.deepEqual([ibViewer.inbox_enabled, ibViewer.inbox_url], [true, null]);
assert.equal(await errCode(asBob("PATCH", `/api/projects/${ib.id}`, { inbox_enabled: false }, 403)), "forbidden");
// Reset and disable: the old link stops working at once, pending uploads too.
const reset = await api("POST", `/api/projects/${ib.id}/inbox/reset`);
assert.notEqual(reset.inbox_url, ibOn.inbox_url);
assert.equal(await errCode(api("GET", `/api/public/inbox/${ibToken}`, undefined, { auth: null, expect: 404 })), "not_found");
// b.txt was started through the old link with its own (valid) upload token.
assert.equal(await errCode(api("POST", `/api/public/inbox/${ibToken}/uploads/${ibb.blob_id}/complete`, {}, { auth: null, headers: wrongTok, expect: 404 })), "not_found");
ibToken = reset.inbox_url.split("/i/")[1];
await api("PATCH", `/api/projects/${ib.id}`, { inbox_enabled: false });
assert.equal(await errCode(api("GET", `/api/public/inbox/${ibToken}`, undefined, { auth: null, expect: 404 })), "not_found");
assert.equal(await errCode(api("POST", `/api/projects/${ib.id}/inbox/reset`, undefined, { expect: 409 })), "conflict");
step("inbox: anonymous single + multipart uploads, auto-rename, upload tokens, viewer view, reset + disable");

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
const inboxBytes = 2 * report.length + big.length;
const stats = await api("GET", "/api/admin/stats?days=7");
assert.equal(stats.series.length, 7);
const today = stats.series.at(-1);
const listingBytes = names.reduce((n, x) => n + Buffer.byteLength(x), 0);
assert.ok(
  today.requests > 20 &&
    today.uploads === 3 + names.length + 3 &&
    today.upload_bytes === small.length + big.length + small2.length + listingBytes + inboxBytes,
  JSON.stringify(today),
);
const users = await api("GET", "/api/admin/users");
assert.ok(users.users.every((u) => u.used_bytes === 0), "usage released after deletes");
assert.equal(users.total, 3);
step(`admin stats (today: ${today.requests} requests, ${today.uploads} uploads, ${today.downloads} downloads)`);

console.log("\nall smoke checks passed");
