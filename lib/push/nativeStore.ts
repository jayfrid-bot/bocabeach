// Native push device-token storage (iOS APNs + Android FCM).
// Production: Cloudflare Workers KV (PUSH_KV binding); legacy/Netlify: Netlify
// Blobs; dev/tests: a gitignored JSON file. Keyed by a base64url hash of the
// token (FCM tokens contain ':' and are long, so they aren't safe as raw keys).

import { promises as fs } from "node:fs";
import path from "node:path";
import { getCloudflareContext } from "@opennextjs/cloudflare";

/** One registered native device, with the beach + prefs + dedup state. */
export interface NativeSub {
  /** Device push token — APNs (hex) on iOS, FCM registration token on Android. */
  token: string;
  platform: "ios" | "android";
  slug: string;
  /** Beach IANA timezone — times the morning summary in local time. */
  tz: string;
  prefs: { morning: boolean; safety: boolean };
  createdAt: string; // ISO
  sent?: { morningDate?: string; safetyKey?: string; safetyAt?: string };
}

const STORE_NAME = "push-native-subscriptions";
const FILE = path.join(process.cwd(), ".push-native-store.json");

/** Key-safe id for a device token (FCM tokens contain ':' and run long). */
const tokenKey = (token: string) => Buffer.from(token).toString("base64url");

/** Common shape every backend adapter returns. */
interface Backend {
  get: (k: string) => Promise<NativeSub | null>;
  set: (k: string, v: NativeSub) => Promise<void>;
  del: (k: string) => Promise<void>;
  list: () => Promise<NativeSub[]>;
}

/** Minimal Workers KV surface we use (avoids a @cloudflare/workers-types dep). */
interface KVLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

/** Cloudflare Workers KV backend (production on Cloudflare). */
async function kvStore(): Promise<Backend | null> {
  try {
    // NOTE: must be a static top-level import (above) — a dynamic import here
    // resolves a context whose bindings aren't wired by the OpenNext bundle.
    // Async form resolves the context even outside a live request scope.
    const ctx = await getCloudflareContext({ async: true });
    const env = ctx?.env as Record<string, unknown> | undefined;
    const kv = env?.PUSH_KV as KVLike | undefined;
    if (!kv) return null;
    return {
      get: (k) => kv.get(k, "json") as Promise<NativeSub | null>,
      set: async (k, v) => {
        await kv.put(k, JSON.stringify(v));
      },
      del: (k) => kv.delete(k),
      list: async () => {
        const out: NativeSub[] = [];
        let cursor: string | undefined;
        do {
          const page = await kv.list(cursor ? { cursor } : undefined);
          for (const { name } of page.keys) {
            const v = (await kv.get(name, "json")) as NativeSub | null;
            if (v) out.push(v);
          }
          cursor = page.list_complete ? undefined : page.cursor;
        } while (cursor);
        return out;
      },
    };
  } catch {
    return null; // not on Cloudflare (or no binding) → fall through
  }
}

/** Netlify Blobs backend (legacy — kept so the app still runs on Netlify). */
async function blobStore(): Promise<Backend | null> {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore(STORE_NAME);
    return {
      get: (k) => store.get(k, { type: "json" }) as Promise<NativeSub | null>,
      set: async (k, v) => {
        await store.setJSON(k, v);
      },
      del: (k) => store.delete(k),
      list: async () => {
        const { blobs } = await store.list();
        const out: NativeSub[] = [];
        for (const b of blobs) {
          const v = (await store.get(b.key, { type: "json" })) as NativeSub | null;
          if (v) out.push(v);
        }
        return out;
      },
    };
  } catch {
    return null; // not on Netlify → file fallback
  }
}

/** Pick the first available remote backend: KV (Cloudflare) → Blobs (Netlify). */
async function remoteBackend(): Promise<Backend | null> {
  return (await kvStore()) ?? (await blobStore());
}

async function readFile(): Promise<Record<string, NativeSub>> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Record<string, NativeSub>;
  } catch {
    return {};
  }
}
async function writeFile(data: Record<string, NativeSub>): Promise<void> {
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
}

export async function getNativeSub(token: string): Promise<NativeSub | null> {
  const k = tokenKey(token);
  const remote = await remoteBackend();
  if (remote) return remote.get(k);
  return (await readFile())[k] ?? null;
}

export async function putNativeSub(sub: NativeSub): Promise<void> {
  const k = tokenKey(sub.token);
  const remote = await remoteBackend();
  if (remote) return remote.set(k, sub);
  const data = await readFile();
  data[k] = sub;
  await writeFile(data);
}

export async function removeNativeSub(token: string): Promise<void> {
  const k = tokenKey(token);
  const remote = await remoteBackend();
  if (remote) return remote.del(k);
  const data = await readFile();
  delete data[k];
  await writeFile(data);
}

export async function listNativeSubs(): Promise<NativeSub[]> {
  const remote = await remoteBackend();
  if (remote) return remote.list();
  return Object.values(await readFile());
}
