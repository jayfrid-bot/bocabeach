// Native push device-token storage (iOS APNs + Android FCM).
// Production: Netlify Blobs; dev/tests: a gitignored JSON file. Keyed by a
// base64url hash of the token (FCM tokens contain ':' and are long, so they
// aren't safe as raw keys).

import { promises as fs } from "node:fs";
import path from "node:path";

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
  sent?: { morningDate?: string; safetyKey?: string };
}

const STORE_NAME = "push-native-subscriptions";
const FILE = path.join(process.cwd(), ".push-native-store.json");

/** Key-safe id for a device token (FCM tokens contain ':' and run long). */
const tokenKey = (token: string) => Buffer.from(token).toString("base64url");

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
  const k = tokenKey(token);
  const blob = await blobStore();
  if (blob) return blob.get(k);
  return (await readFile())[k] ?? null;
}

export async function putNativeSub(sub: NativeSub): Promise<void> {
  const k = tokenKey(sub.token);
  const blob = await blobStore();
  if (blob) return blob.set(k, sub);
  const data = await readFile();
  data[k] = sub;
  await writeFile(data);
}

export async function removeNativeSub(token: string): Promise<void> {
  const k = tokenKey(token);
  const blob = await blobStore();
  if (blob) return blob.del(k);
  const data = await readFile();
  delete data[k];
  await writeFile(data);
}

export async function listNativeSubs(): Promise<NativeSub[]> {
  const blob = await blobStore();
  if (blob) return blob.list();
  return Object.values(await readFile());
}
