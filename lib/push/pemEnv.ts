// Read a PEM private key from the environment, robustly.
//
// PEM keys begin with "-----BEGIN …" and are multi-line — both of which trip up
// `netlify env:set` (a leading "--" looks like a CLI flag; newlines get mangled).
// So we prefer a base64 form, `<NAME>_B64`, which is single-line and dash-free
// (set with: netlify env:set <NAME>_B64 "$(openssl base64 -A -in key.p8)").
// Falls back to the raw `<NAME>` (real newlines, or literal \n which we unescape).

export function readPemEnv(name: string): string {
  const b64 = process.env[`${name}_B64`] ?? "";
  if (b64) {
    try {
      return Buffer.from(b64, "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  return (process.env[name] ?? "").replace(/\\n/g, "\n");
}
