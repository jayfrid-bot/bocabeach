// Minimal S3-compatible client for R2, used only by scripts/cam_archive_remove.ts
// to LIST the real objects under a cam's prefix (wrangler has no `r2 object
// list`). Pure Node (node:crypto), AWS Signature Version 4, path-style URLs:
//
//   https://<account_id>.r2.cloudflarestorage.com/<bucket>?list-type=2&prefix=...
//
// Credentials come from the caller (the script reads R2_ACCESS_KEY_ID and
// R2_SECRET_ACCESS_KEY from the environment). Nothing here prints or stores them.

import { createHash, createHmac } from "node:crypto";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** RFC 3986 percent-encoding, as SigV4 wants it (everything but A-Z a-z 0-9 - _ . ~). */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SigV4Input {
  method: string;
  /** Host header value, e.g. abc123.r2.cloudflarestorage.com */
  host: string;
  /** Absolute path, already URI-encoded as it will be sent, e.g. /my-bucket */
  path: string;
  /** Query parameters (unencoded); sorted and encoded here. */
  query: Record<string, string>;
  accessKeyId: string;
  secretAccessKey: string;
  /** Request time as YYYYMMDDTHHMMSSZ. */
  amzDate: string;
  region: string;
  service: string;
  /** Extra headers to sign (lowercase names). host and x-amz-date are always signed. */
  extraHeaders?: Record<string, string>;
  /** Hex SHA-256 of the body ("" body by default). */
  payloadHash?: string;
}

/** Returns the Authorization header value and the signature, per AWS SigV4. */
export function signV4(input: SigV4Input): { authorization: string; signature: string; signedHeaders: string } {
  const payloadHash = input.payloadHash ?? EMPTY_SHA256;
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-date": input.amzDate,
    ...(input.extraHeaders ?? {}),
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalQuery = Object.keys(input.query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(input.query[k])}`)
    .join("&");
  const canonicalRequest = [input.method, input.path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const date = input.amzDate.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", input.amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    signature,
    signedHeaders,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function amzDateOf(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function xmlUnescape(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export interface ListPage {
  keys: string[];
  truncated: boolean;
  nextToken: string | null;
}

/** Parse a ListObjectsV2 XML response. */
export function parseListObjectsV2(xml: string): ListPage {
  const keys = [...xml.matchAll(/<Contents>[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g)].map((m) => xmlUnescape(m[1]));
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return { keys, truncated, nextToken: next ? xmlUnescape(next[1]) : null };
}

export interface R2S3Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Every object key under `prefix`, following continuation tokens. Throws on an HTTP error. */
export async function listR2Prefix(cfg: R2S3Config, prefix: string): Promise<string[]> {
  const host = `${cfg.accountId}.r2.cloudflarestorage.com`;
  const path = `/${uriEncode(cfg.bucket)}`;
  const doFetch = cfg.fetchImpl ?? fetch;
  const keys: string[] = [];
  let token: string | null = null;
  for (let page = 0; page < 1000; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
    if (token) query["continuation-token"] = token;
    const amzDate = amzDateOf((cfg.now ?? (() => new Date()))());
    const { authorization } = signV4({
      method: "GET",
      host,
      path,
      query,
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
      amzDate,
      region: "auto",
      service: "s3",
      extraHeaders: { "x-amz-content-sha256": EMPTY_SHA256 },
    });
    const qs = Object.keys(query)
      .sort()
      .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
      .join("&");
    const res = await doFetch(`https://${host}${path}?${qs}`, {
      headers: { "x-amz-date": amzDate, "x-amz-content-sha256": EMPTY_SHA256, authorization },
    });
    if (!res.ok) throw new Error(`R2 list failed: HTTP ${res.status}`);
    const parsed = parseListObjectsV2(await res.text());
    keys.push(...parsed.keys);
    if (!parsed.truncated || !parsed.nextToken) return keys;
    token = parsed.nextToken;
  }
  throw new Error("R2 list: too many pages");
}
