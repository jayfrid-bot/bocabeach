// Erase one cam from the webcam archive (docs/CAM_ARCHIVE_PLAN.md R6).
//
//   npx vite-node -c vitest.config.ts scripts/cam_archive_remove.ts <slug> <camId>            # dry run
//   npx vite-node -c vitest.config.ts scripts/cam_archive_remove.ts <slug> <camId> --dry-run  # dry run
//   npx vite-node -c vitest.config.ts scripts/cam_archive_remove.ts <slug> <camId> --yes      # DELETES
//
// First set `archive: false` on the cam in config/locations.ts and deploy, so
// no new frame arrives. The default is a read-only dry run (one SELECT). With
// --yes it deletes each R2 object with `wrangler r2 object delete --remote`,
// then the D1 rows with `wrangler d1 execute --remote`. All the logic, and its
// tests, live in lib/camFrames/removal.ts.

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { errorLineOf, parseWranglerJson } from "@/lib/scorecard/wrangler";
import { D1_DATABASE, parseRemoveArgs, R2_BUCKET, runRemoval, type RemovalIo } from "@/lib/camFrames/removal";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function wrangler(args: string[], timeout: number): Promise<string> {
  try {
    const { stdout } = await run("npx", ["wrangler", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout,
    });
    return stdout;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    throw new Error(errorLineOf(`${err.stdout ?? ""}\n${err.stderr ?? ""}`));
  }
}

const io: RemovalIo = {
  async d1(sql) {
    const stdout = await wrangler(["d1", "execute", D1_DATABASE, "--remote", "--json", "--command", sql], 240_000);
    const parsed = parseWranglerJson(stdout) as { results?: Record<string, unknown>[]; success?: boolean; error?: unknown }[];
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    if (!first || first.success === false) {
      throw new Error(errorLineOf(JSON.stringify(first?.error ? { error: first.error } : (parsed ?? "no result"))));
    }
    return first.results ?? [];
  },
  async r2Delete(key) {
    await wrangler(["r2", "object", "delete", `${R2_BUCKET}/${key}`, "--remote"], 120_000);
  },
  log: (line) => console.error(line),
};

const args = parseRemoveArgs(process.argv.slice(2));
if ("error" in args) {
  console.error(args.error);
  process.exit(2);
}
runRemoval(args, io).then(
  () => undefined,
  (e) => {
    console.error(`failed: ${(e as Error).message}`);
    process.exit(1);
  },
);
