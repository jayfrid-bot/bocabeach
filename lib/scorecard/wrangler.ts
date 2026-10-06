// Pure helpers for reading `wrangler d1 execute --json` output. Kept apart from
// scripts/scorecard.ts (which runs on import) so they can be unit-tested.

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

type Loose = { [k: string]: unknown };

/** The message inside a wrangler `--json` error document, if `v` is one. */
function messageOfJsonError(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Loose;
  const err = (o.error ?? o) as Loose | string;
  if (typeof err === "string") return err;
  if (!err || typeof err !== "object") return null;
  const notes = Array.isArray(err.notes) ? (err.notes as Loose[]) : [];
  const note = notes.find((n) => typeof n?.text === "string")?.text;
  const text = typeof err.text === "string" ? err.text : typeof err.message === "string" ? err.message : null;
  return (typeof note === "string" ? note : null) ?? text;
}

/**
 * The most useful single line from wrangler output that failed. With `--json`
 * wrangler prints an error document ({"error": {"text", "notes": [...]}}), so
 * look for that first; otherwise take the first line that names an error.
 */
export function errorLineOf(text: string): string {
  const clean = stripAnsi(text);
  const open = clean.indexOf("{");
  const close = clean.lastIndexOf("}");
  if (open !== -1 && close > open) {
    try {
      const msg = messageOfJsonError(JSON.parse(clean.slice(open, close + 1)));
      if (msg) return msg.split("\n")[0].trim().slice(0, 300);
    } catch {
      // not a JSON document: fall through to the line search
    }
  }
  const lines = clean
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const hit = lines.find((l) => /ERROR|error:|✘|failed|denied|not logged in/i.test(l)) ?? lines[0] ?? "wrangler failed";
  return hit
    .replace(/^[✘X]\s*/, "")
    .replace(/^\[ERROR\]\s*/i, "")
    .slice(0, 300);
}

/**
 * wrangler may print a banner line before the JSON. Find the first `[` that
 * starts text which parses as JSON, and return the parsed value. Throws when
 * there is none.
 */
export function parseWranglerJson(stdout: string): unknown {
  const text = stripAnsi(stdout);
  let from = text.indexOf("[");
  while (from !== -1) {
    try {
      return JSON.parse(text.slice(from));
    } catch {
      from = text.indexOf("[", from + 1);
    }
  }
  throw new Error("wrangler printed no JSON");
}
