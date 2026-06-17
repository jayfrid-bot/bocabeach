// VAPID configuration for Web Push, read from environment.
//
// Generate a keypair once with `npx web-push generate-vapid-keys` and set:
//   NEXT_PUBLIC_VAPID_PUBLIC_KEY  (client + server; safe to expose)
//   VAPID_PRIVATE_KEY             (server only — NEVER commit / expose)
//   VAPID_SUBJECT                 (a mailto: or https: contact, e.g. mailto:you@site.com)
// Locally these live in .env.local; in production set them as Netlify env vars.

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

/** The public key, available to the client (or "" when push isn't configured). */
export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";

/** Full server-side VAPID config, or null when keys aren't configured. */
export function getVapid(): VapidConfig | null {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
  const privateKey = process.env.VAPID_PRIVATE_KEY ?? "";
  const subject = process.env.VAPID_SUBJECT ?? "mailto:hello@isitbeachday.com";
  if (!publicKey || !privateKey) return null;
  return { publicKey, privateKey, subject };
}
