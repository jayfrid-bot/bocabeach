// Test helpers for the quality loop: real SQLite with every migration applied
// (lib/camFrames/testDb.ts), plus rows for the tables the loop reads. Only
// *.test.ts files import this.

import type { D1Like } from "@/lib/db/d1Store";
import { claimSlot, markReady } from "@/lib/camFrames/store";
import { CLAIM_A, frameRow } from "@/lib/camFrames/testFixtures";
import type { CamFrameRow } from "@/lib/camFrames/store";
import type { JumpRow } from "@/lib/quality/jumps";
import type { SendOwnerPush, OwnerPush, OwnerPushResult } from "@/lib/quality/notify";
import { createSession, newOwnerToken, setSessionPushToken } from "@/lib/quality/ownerSessions";

/** A `beach_hourly` row for the columns the watchdog and the report read; override any. */
export function hourlyValues(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: "boca-raton",
    hour_utc: "2026-10-13T16:00:00.000Z",
    snapshot_generated_at: "2026-10-13T16:05:00.000Z",
    archived_at: "2026-10-13T16:05:00.000Z",
    local_date: "2026-10-13",
    local_hour: 12,
    utc_offset_minutes: -240,
    timezone: "America/New_York",
    score: 80,
    wave_ft: 2,
    surf_ft: 2,
    wave_source: "model",
    sand_temp_f: 90,
    clarity_pct: 80,
    seaweed_level: "none",
    rain_now: 0,
    lightning_near: 0,
    wind_mph: 10,
    cloud_pct: 20,
    caps_json: "[]",
    factors_json: JSON.stringify(
      ["airTemp", "sky", "wind", "waves"].map((key) => ({ key, label: key, score: 90, weight: 0.25 })),
    ),
    engine_version: "test",
    scoring_config_version: "test",
    row_kind: "snapshot",
    ...over,
  };
}

export async function insertHourly(db: D1Like, over: Record<string, unknown> = {}): Promise<JumpRow & Record<string, unknown>> {
  const v = hourlyValues(over);
  const cols = Object.keys(v);
  await db
    .prepare(`INSERT INTO beach_hourly (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...cols.map((c) => v[c]))
    .run();
  return v as JumpRow & Record<string, unknown>;
}

/** A ready `cam_frames` row. `at` sets display time; the key and slot follow it. */
export async function insertFrame(db: D1Like, over: Partial<CamFrameRow> & { at?: string } = {}): Promise<CamFrameRow> {
  const { at, ...rest } = over;
  const display = at ?? rest.display_at_utc ?? "2026-10-13T17:20:00.000Z";
  const d = new Date(display);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const slug = rest.slug ?? "boca-raton";
  const cam = rest.cam_id ?? "boca-inlet-surf";
  const sha = rest.sha256 ?? "0123456789abcdef".repeat(4);
  const row = frameRow({
    slug,
    cam_id: cam,
    slot_utc: `${display.slice(0, 13)}:00:00.000Z`,
    received_at_utc: display,
    claimed_at_utc: display,
    display_at_utc: display,
    local_date: "2026-10-13",
    r2_key: `${slug}/${cam}/2026-10-13/${hh}${mm}Z-${sha.slice(0, 8)}-cccccccc.jpg`,
    sha256: sha,
    ...rest,
  });
  await claimSlot(db, row);
  await markReady(db, row.slug, row.cam_id, row.slot_utc, CLAIM_A);
  return row;
}

/** A push sender that records what it was asked to send. */
export function fakeSender(result: Partial<OwnerPushResult> = {}): SendOwnerPush & { sent: OwnerPush[] } {
  const sent: OwnerPush[] = [];
  const fn = (async (_db: D1Like, msg: OwnerPush) => {
    sent.push(msg);
    return { ok: true, sent: 1, failed: 0, ...result };
  }) as SendOwnerPush & { sent: OwnerPush[] };
  fn.sent = sent;
  return fn;
}

/** Enroll a fake owner phone straight in the database (a new device each call unless `deviceId` is given). Returns its token, and the session id. */
export async function seedOwnerSession(
  db: D1Like,
  opts: { pushToken?: string; deviceId?: string; nowMs?: number } = {},
): Promise<{ token: string; id: number }> {
  const token = newOwnerToken();
  const nowMs = opts.nowMs ?? Date.now();
  const id = await createSession(db, { deviceId: opts.deviceId ?? crypto.randomUUID(), token, nowMs });
  if (opts.pushToken) await setSessionPushToken(db, id, opts.pushToken, nowMs);
  return { token, id };
}

/** Insert an override row straight into the database (answerAlert is what writes them in production). */
export function insertOverrideRow(db: D1Like, over: Record<string, unknown> = {}): Promise<unknown> {
  const v: Record<string, unknown> = {
    alert_id: 1,
    superseded: 0,
    slug: "boca-raton",
    signal: "seaweed",
    cam_id: "boca-inlet-surf",
    frame_sha: "a".repeat(20),
    frame_at: null,
    claimed_at: "2026-10-13T17:21:00Z",
    local_date: "2026-10-13",
    verdict: "right",
    action: "publish",
    level: "moderate",
    coverage_pct: 35,
    note: null,
    created_at_utc: "2026-10-13T17:35:00.000Z",
    until_utc: "2026-10-14T04:00:00.000Z",
    ...over,
  };
  const cols = Object.keys(v);
  return db
    .prepare(`INSERT INTO quality_overrides (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`)
    .bind(...cols.map((c) => v[c]))
    .run();
}
