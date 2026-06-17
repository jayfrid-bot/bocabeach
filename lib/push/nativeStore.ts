// Native (APNs) device-token storage — the native-app sibling of store.ts.
// Production: Netlify Blobs; dev/tests: a gitignored JSON file. Keyed by token.

import { promises as fs } from "node:fs";
import path from "node:path";

/** One registered native device, with the beach + prefs + dedup state. */
export interface NativeSub {
  /** APNs device token (hex). */
  token: string;
  platform: "ios";
  slug: string;
  /** Beach IANA timezone — times the morning summary in local time. */
  tz: string;
  prefs: { morning: boolean; safety: boolean };
  createdAt: string; // ISO
  sent?: { morningDate?: string; safetyKey?: string };
}

const STORE_NAME = "push-native-subscriptions";
const FILE = path.join(process.cwd(), ".push-native-store.json");

async function blobStore(): Promise<{
  get: (k: string) => Promise<NativeSub | null>;
  set: (k: string, v: NativeSub) => Promise<void>;
  del: (k: string) => Promise<void>;
  list: () => Promise<NativeSub[]>;
} | null> {
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
  const blob = await blobStore();
  if (blob) return blob.get(token);
  return (await readFile())[token] ?? null;
}

export async function putNativeSub(sub: NativeSub): Promise<void> {
  const blob = await blobStore();
  if (blob) return blob.set(sub.token, sub);
  const data = await readFile();
  data[sub.token] = sub;
  await writeFile(data);
}

export async function removeNativeSub(token: string): Promise<void> {
  const blob = await blobStore();
  if (blob) return blob.del(token);
  const data = await readFile();
  delete data[token];
  await writeFile(data);
}

export async function listNativeSubs(): Promise<NativeSub[]> {
  const blob = await blobStore();
  if (blob) return blob.list();
  return Object.values(await readFile());
}
