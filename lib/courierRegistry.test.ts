// The cam courier builds its cam list from config (scripts/courier_schedule.py), not from
// the shell script. This test runs its `check`, so a cam that the courier cannot grab fails
// here, before it reaches the server:
//   - a "direct" archive/vision cam with no YouTube video id (add it to config/sun-cams.json
//     or config/courier-cams.json), or
//   - a courier cam missing from workers/uw-frame/src/lib/schedule.ts (CAMERA_REGISTRY and the
//     CameraId type): POST /ingest answers 404 for it, and every grab would burn a yt-dlp call
//     (the home IP gets about 150 per 15 minutes before YouTube asks "are you a bot").
// Skipped when python3 is not installed.

import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const hasPython = spawnSync("python3", ["--version"]).status === 0;

describe.skipIf(!hasPython)("courier registry", () => {
  it("every courier cam has a video id and is known to the uw-frame worker", () => {
    let out = "";
    try {
      out = execFileSync("python3", ["scripts/courier_schedule.py", "check"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { stderr?: string; stdout?: string };
      throw new Error(`courier_schedule.py check failed:\n${err.stderr ?? ""}${err.stdout ?? ""}`);
    }
    expect(out).toMatch(/\d+ courier cam\(s\), 0 problem\(s\)/);
  });
});
