import { describe, it, expect } from "vitest";
import { shouldCancelPendingFind } from "@/lib/plus/firstRun";

describe("shouldCancelPendingFind (R-03: dismiss cancels a pending find)", () => {
  it("does not cancel while the ticket it started with is still current", () => {
    const findTicket = { current: 1 };
    const ticket = findTicket.current; // find() took this ticket before awaiting
    expect(shouldCancelPendingFind(ticket, findTicket.current)).toBe(false);
  });

  it("cancels once dismiss() bumps the ticket while the position request is out", () => {
    const findTicket = { current: 0 };
    const ticket = ++findTicket.current; // find() takes ticket 1, then awaits
    findTicket.current += 1; // dismiss(): "no thanks" while it was in flight
    expect(shouldCancelPendingFind(ticket, findTicket.current)).toBe(true);
  });

  it("does not cancel a second find() started after the first settled", () => {
    // find() #1 completes normally (ticket stays 1), then find() #2 starts
    // and takes ticket 2 — #2 must not read as cancelled against its own ticket.
    const findTicket = { current: 1 };
    const ticket = ++findTicket.current;
    expect(shouldCancelPendingFind(ticket, findTicket.current)).toBe(false);
  });
});
