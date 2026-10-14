"use client";

// What /admin/review shows a phone that is not enrolled as the owner: one "Owner code" box and one
// "Enroll" button, and nothing else (no title, no hint about what this page is). The code is sent in
// the BODY of POST /api/quality/owner/enroll, exactly like the #enroll= link does, so it passes the
// same throttle (lib/quality/enrollThrottle.ts). It is never put in an address, and the box is cleared
// after every try, right or wrong. This is how the owner enrolls INSIDE the iPhone app, which has no
// address bar to paste a link into.

import { useState } from "react";
import { getDeviceId } from "@/lib/deviceId";
import { enrollGateText, enrollThisPhone } from "@/lib/quality/client";
import { bigBtn, inputCls } from "@/components/admin/ownerUi";

export function OwnerCodeGate({ initialError, onEnrolled }: { initialError: string | null; onEnrolled: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ? enrollGateText(initialError) : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const typed = code.trim();
    if (!typed || busy) return;
    setBusy(true);
    setError(null);
    setCode(""); // out of the box at once, whatever happens next
    const r = await enrollThisPhone(typed, getDeviceId());
    setBusy(false);
    if (r.ok) onEnrolled();
    else setError(enrollGateText(r.error));
  };

  return (
    <main className="mx-auto max-w-xl px-4 py-10 sm:px-6">
      <form onSubmit={(e) => void submit(e)} autoComplete="off" className="space-y-3">
        <label htmlFor="owner-code" className="block text-sm font-medium text-slate-700 dark:text-slate-300">
          Owner code
        </label>
        <input
          id="owner-code"
          name="owner-code"
          type="password"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className={inputCls}
        />
        <button type="submit" disabled={busy || !code.trim()} className={`${bigBtn} bg-ocean-600 text-white hover:bg-ocean-500`}>
          Enroll
        </button>
        {error ? (
          <p role="alert" className="text-sm text-slate-600 dark:text-slate-400">
            {error}
          </p>
        ) : null}
      </form>
    </main>
  );
}
