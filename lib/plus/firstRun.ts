// FirstRunBanner's "find my nearest beach" flow: pure enough to unit-test
// directly rather than through a rendered banner.

/**
 * Should the pending `find()` continuation be cancelled (R-03)? `find()`
 * takes a ticket from `findTicket` before awaiting the position request;
 * `dismiss()` bumps the ref while that await is out. If the ticket this call
 * started with no longer matches the ref, the person already said "no
 * thanks" — the home-beach set and the redirect must not happen.
 */
export function shouldCancelPendingFind(ticketAtStart: number, currentTicket: number): boolean {
  return ticketAtStart !== currentTicket;
}
