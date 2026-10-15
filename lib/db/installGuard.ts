// The install-token guard that rides INSIDE a write (push-token-auth).
//
// A route used to read "does this caller hold the token?" and then, in a second
// step, write. That leaves a gap between the two. Now the route builds an
// `InstallGuard` from the request and hands it to the store method that does
// the write; the store applies it in the SAME statement (d1Store: a WHERE
// clause; memoryStore: the same check with no `await` in between). A write the
// guard refuses changes nothing.
//
// The comparison inside SQL is a plain equality of two sha256 digests. That is
// fine: the digest of a guess tells an attacker nothing about the stored digest
// beyond what a wrong guess already does, and a timing difference on a hash
// prefix does not help anyone find a preimage. The raw token never reaches the
// database.
//
// Modes, picked by the INSTALL_TOKEN_ENFORCE env flag (docs/architecture.md,
// "Staged rollout"):
//   enforce on   the row must carry a token hash AND the request's hash must
//                match it. A row with no hash, or a request with no token, is
//                refused.
//   enforce off  as before this gate existed, except that a token which IS
//                sent is still checked: it must match a hash on file, or the
//                row must have none yet. A request with no token passes.

import { createHash, timingSafeEqual } from "node:crypto";

export interface InstallGuard {
  /** sha256 hex of the token the request carried, or null when it sent none. */
  hash: string | null;
  enforce: boolean;
}

/** A guard that refuses nothing — for internal callers (cron, webhooks). */
export const NO_GUARD: InstallGuard = { hash: null, enforce: false };

/** True when the server should refuse writes that lack a valid install token. */
export function installTokenEnforced(): boolean {
  return process.env.INSTALL_TOKEN_ENFORCE === "on";
}

export function hashOfToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Build the guard for a request from its `x-install-token` header. */
export function guardFromHeader(header: string | null, enforce = installTokenEnforced()): InstallGuard {
  return { hash: header ? hashOfToken(header) : null, enforce };
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The JS twin of the SQL predicate in d1Store (`guardSql`): does a row whose
 *  stored hash is `rowHash` (null/undefined = none) pass this guard? */
export function guardAllows(rowHash: string | null | undefined, guard: InstallGuard): boolean {
  if (guard.enforce) return !!rowHash && !!guard.hash && sameHash(rowHash, guard.hash);
  return guard.hash === null || !rowHash || sameHash(rowHash, guard.hash);
}

/** True when the guard can refuse anything at all (so a store has to look). */
export function guardIsActive(guard: InstallGuard | undefined): guard is InstallGuard {
  return !!guard && (guard.enforce || guard.hash !== null);
}

/** Thrown by a guarded store write that the guard refused. Routes answer 401. */
export class InstallGuardDenied extends Error {
  constructor() {
    super("install token refused");
    this.name = "InstallGuardDenied";
  }
}

/** Thrown by getStore() in production when the D1 binding is missing. Routes
 *  answer 503: the memory store must never stand in for the database there. */
export class StoreUnavailableError extends Error {
  constructor() {
    super("device store unavailable");
    this.name = "StoreUnavailableError";
  }
}
