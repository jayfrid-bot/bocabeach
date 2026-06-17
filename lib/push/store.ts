// Web-push subscription storage.
//
// Production: Netlify Blobs (zero-config, concurrent-safe key/value on Netlify).
// Local dev / tests: a single JSON file (.push-store.json, gitignored), since
// Netlify Blobs isn't available outside the Netlify runtime. The two share one
// tiny KV interface so callers don't care which backend is live.

import { promises as fs } from "node:fs";
import path from "node:path";

/** One stored push subscription (the browser's PushSubscription + our metadata). */
export interface StoredSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Beach slug this subscription wants alerts for. */
  slug: string;
  /** Beach IANA timezone — used to time the morning summary in local time. */
  tz: string;
  prefs: { morning: boolean; safety: boolean };
  createdAt: string; // ISO
  /** Per-subscription dedup state, updated by the sender after each send. */
  sent?: { morningDate?: string; safetyKey?: string };
}

const STORE_NAME = "push-subscriptions";
const FILE = path.join(process.cwd(), ".push-store.json");

/** A unique, key-safe id for a subscription endpoint. */
export function endpointKey(endpoint: string): string {
  // Base64url of the endpoint — stable and safe as a blob/file key.
  return Buffer.from(endpoint).toString("base64url");
}

// --- Netlify Blobs backend (lazy, optional) --------------------------------
async function blobStore(): Promise<{
  get: (k: string) => Promise<StoredSub | null>;
  set: (k: string, v: StoredSub) => Promise<void>;
  del: (k: string) => Promise<void>;
  list: () => Promise<StoredSub[]>;
} | null> {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore(STORE_NAME);
    return {
      get: (k) => store.get(k, { type: "json" }) as Promise<StoredSub | null>,
      set: async (k, v) => {
        await store.setJSON(k, v);
      },
      del: (k) => store.delete(k),
      list: async () => {
        const { blobs } = await store.list();
        const out: StoredSub[] = [];
        for (const b of blobs) {
          const v = (await store.get(b.key, { type: "json" })) as StoredSub | null;
          if (v) out.push(v);
        }
        return out;
      },
    };
  } catch {
    return null; // not running on Netlify (or Blobs unavailable) → file fallback
  }
}

// --- File backend (dev / tests) --------------------------------------------
async function readFile(): Promise<Record<string, StoredSub>> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8")) as Record<string, StoredSub>;
  } catch {
    return {};
  }
}
async function writeFile(data: Record<string, StoredSub>): Promise<void> {
  await fs.writeFile(FILE, JSON.stringify(data, null, 2));
}

// --- Public API ------------------------------------------------------------
export async function getSubscription(endpoint: string): Promise<StoredSub | null> {
  const key = endpointKey(endpoint);
  const blob = await blobStore();
  if (blob) return blob.get(key);
  return (await readFile())[key] ?? null;
}

export async function putSubscription(sub: StoredSub): Promise<void> {
  const key = endpointKey(sub.endpoint);
  const blob = await blobStore();
  if (blob) return blob.set(key, sub);
  const data = await readFile();
  data[key] = sub;
  await writeFile(data);
}

export async function removeSubscription(endpoint: string): Promise<void> {
  const key = endpointKey(endpoint);
  const blob = await blobStore();
  if (blob) return blob.del(key);
  const data = await readFile();
  delete data[key];
  await writeFile(data);
}

export async function listSubscriptions(): Promise<StoredSub[]> {
  const blob = await blobStore();
  if (blob) return blob.list();
  return Object.values(await readFile());
}
