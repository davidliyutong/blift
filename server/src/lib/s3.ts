// Tiny S3 client on top of aws4fetch (SigV4), tested against RustFS and Backblaze B2; written
// for AWS S3, Cloudflare R2 and MinIO as well. Note B2 keeps every version: a delete
// without VersionId only hides the object, so B2 buckets need the "Keep only the last
// version" lifecycle (see README). File bytes never flow through here: clients use the
// presigned URLs. Every method below is exactly one subrequest (except listParts paging).
import { AwsClient } from "aws4fetch";
import { createHash } from "node:crypto";
import { ApiError } from "./errors";

export type S3Config = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathStyle: boolean;
};

export type Part = { part_number: number; etag: string };

const xmlEscape = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
const xmlUnescape = (s: string) =>
  s.replace(/&(lt|gt|amp|apos|quot|#34|#39);/g, (_, e) =>
    ({ lt: "<", gt: ">", amp: "&", apos: "'", quot: '"', "#34": '"', "#39": "'" })[e as string]!,
  );
const xmlValue = (xml: string, tag: string) => {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? xmlUnescape(m[1]) : null;
};
const xmlBlocks = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g")) ?? [];

const md5b64 = (body: string) => createHash("md5").update(body).digest("base64");

export function storageError(code: string, message: string, status = 0) {
  return new ApiError(502, "storage_error", `${code || `HTTP ${status}`}: ${message}`.trim());
}

async function toError(res: Response): Promise<ApiError> {
  const body = await res.text().catch(() => "");
  return storageError(xmlValue(body, "Code") ?? "", xmlValue(body, "Message") ?? res.statusText, res.status);
}

/** RFC 6266 Content-Disposition without spaces (so presigned query values never contain '+'). */
export function contentDisposition(name: string, inline = false): string {
  const ascii = name.replace(/[^A-Za-z0-9._-]/g, "_");
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"};filename="${ascii}";filename*=UTF-8''${utf8}`;
}

export class S3 {
  private readonly aws: AwsClient;

  constructor(private readonly cfg: S3Config) {
    this.aws = new AwsClient({
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      service: "s3",
      region: cfg.region || "auto",
      retries: 1, // aws4fetch defaults to 10 retries; that would burn the Workers subrequest budget
    });
  }

  url(key = "", query: Record<string, string> = {}): string {
    const ep = new URL(this.cfg.endpoint);
    const base = ep.pathname.replace(/\/$/, "");
    const path = key ? `/${key.split("/").map(encodeURIComponent).join("/")}` : "";
    const u = this.cfg.pathStyle
      ? new URL(`${ep.origin}${base}/${this.cfg.bucket}${path}`)
      : new URL(`${ep.protocol}//${this.cfg.bucket}.${ep.host}${base}${path || "/"}`);
    for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  async presign(method: "GET" | "PUT", key: string, expiresIn: number, query: Record<string, string> = {}) {
    const u = new URL(this.url(key, query));
    u.searchParams.set("X-Amz-Expires", String(expiresIn));
    const signed = await this.aws.sign(u.toString(), { method, aws: { signQuery: true } });
    return signed.url;
  }

  presignGet(key: string, expiresIn: number, filename: string, opts: { inline?: boolean; contentType?: string } = {}) {
    const q: Record<string, string> = { "response-content-disposition": contentDisposition(filename, opts.inline) };
    if (opts.inline && opts.contentType) q["response-content-type"] = opts.contentType.replace(/\s+/g, "");
    return this.presign("GET", key, expiresIn, q);
  }

  presignPart(key: string, uploadId: string, partNumber: number, expiresIn: number) {
    return this.presign("PUT", key, expiresIn, { partNumber: String(partNumber), uploadId });
  }

  private async send(method: string, key: string, init: { query?: Record<string, string>; body?: string; headers?: Record<string, string> } = {}) {
    const res = await this.aws.fetch(this.url(key, init.query), { method, body: init.body, headers: init.headers });
    if (!res.ok) throw await toError(res);
    return res;
  }

  async createMultipart(key: string, contentType: string): Promise<string> {
    const res = await this.send("POST", key, { query: { uploads: "" }, headers: { "content-type": contentType } });
    const id = xmlValue(await res.text(), "UploadId");
    if (!id) throw storageError("InvalidResponse", "CreateMultipartUpload returned no UploadId");
    return id;
  }

  async completeMultipart(key: string, uploadId: string, parts: Part[]): Promise<void> {
    const body =
      "<CompleteMultipartUpload>" +
      [...parts]
        .sort((a, b) => a.part_number - b.part_number)
        .map((p) => `<Part><PartNumber>${p.part_number}</PartNumber><ETag>${xmlEscape(p.etag)}</ETag></Part>`)
        .join("") +
      "</CompleteMultipartUpload>";
    const res = await this.send("POST", key, { query: { uploadId }, body, headers: { "content-type": "application/xml" } });
    // S3 may answer 200 OK with an <Error> body.
    const text = await res.text();
    if (text.includes("<Error>")) throw storageError(xmlValue(text, "Code") ?? "", xmlValue(text, "Message") ?? "");
  }

  async listParts(key: string, uploadId: string): Promise<(Part & { size: number })[]> {
    const parts: (Part & { size: number })[] = [];
    let marker = "0";
    for (;;) {
      const res = await this.send("GET", key, { query: { uploadId, "max-parts": "1000", "part-number-marker": marker } });
      const xml = await res.text();
      for (const p of xmlBlocks(xml, "Part")) {
        parts.push({
          part_number: Number(xmlValue(p, "PartNumber")),
          etag: xmlValue(p, "ETag") ?? "",
          size: Number(xmlValue(p, "Size")),
        });
      }
      if (xmlValue(xml, "IsTruncated") !== "true") return parts;
      marker = xmlValue(xml, "NextPartNumberMarker") ?? String(parts.at(-1)?.part_number ?? 0);
    }
  }

  async abortMultipart(key: string, uploadId: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key, { uploadId }), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw await toError(res);
  }

  async head(key: string): Promise<{ size: number; etag: string } | null> {
    const res = await this.aws.fetch(this.url(key), { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) throw storageError("", res.statusText, res.status);
    return { size: Number(res.headers.get("content-length") ?? 0), etag: res.headers.get("etag") ?? "" };
  }

  /**
   * GET through the server (WebDAV only; everything else downloads with presigned URLs). The
   * response is handed on as it is: 200, 206 for a range, 416; null when the object is missing.
   */
  async get(key: string, headers: Record<string, string> = {}): Promise<Response | null> {
    const res = await this.aws.fetch(this.url(key), { method: "GET", headers });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 416) throw await toError(res);
    return res;
  }

  /** CopyObject inside the bucket (objects up to 5 GiB). */
  async copy(from: string, to: string): Promise<void> {
    const source = `/${this.cfg.bucket}/${from.split("/").map(encodeURIComponent).join("/")}`;
    const res = await this.send("PUT", to, { headers: { "x-amz-copy-source": source } });
    const text = await res.text();
    if (text.includes("<Error>")) throw storageError(xmlValue(text, "Code") ?? "", xmlValue(text, "Message") ?? "");
  }

  async put(key: string, body: string): Promise<void> {
    await this.send("PUT", key, { body, headers: { "content-type": "text/plain" } });
  }

  async delete(key: string): Promise<void> {
    const res = await this.aws.fetch(this.url(key), { method: "DELETE" });
    if (!res.ok && res.status !== 404) throw await toError(res);
  }

  /** DeleteObjects, up to 1000 keys per call. Returns the keys that failed. */
  async deleteMany(keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const body =
      "<Delete><Quiet>true</Quiet>" + keys.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join("") + "</Delete>";
    const res = await this.send("POST", "", {
      query: { delete: "" },
      body,
      headers: { "content-type": "application/xml", "content-md5": md5b64(body) },
    });
    return xmlBlocks(await res.text(), "Error")
      .filter((e) => xmlValue(e, "Code") !== "NoSuchKey")
      .map((e) => xmlValue(e, "Key") ?? "");
  }

  async putCors(origins: string[]): Promise<void> {
    const body =
      "<CORSConfiguration><CORSRule>" +
      origins.map((o) => `<AllowedOrigin>${xmlEscape(o)}</AllowedOrigin>`).join("") +
      ["GET", "PUT", "HEAD"].map((m) => `<AllowedMethod>${m}</AllowedMethod>`).join("") +
      "<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds>" +
      "</CORSRule></CORSConfiguration>";
    await this.send("PUT", "", {
      query: { cors: "" },
      body,
      headers: { "content-type": "application/xml", "content-md5": md5b64(body) },
    });
  }
}
