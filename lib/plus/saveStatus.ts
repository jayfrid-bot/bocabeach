export type SaveStatus = "idle" | "saving" | "saved" | "retrying";

/** What the alerts Save button shows. Failed saves outrank everything: the
 *  person must never see "Saved" while a change is still unsent. */
export function alertSaveStatus(input: {
  inFlight: number;
  pendingCount: number;
  justSaved: boolean;
}): SaveStatus {
  if (input.pendingCount > 0) return "retrying";
  if (input.inFlight > 0) return "saving";
  return input.justSaved ? "saved" : "idle";
}
