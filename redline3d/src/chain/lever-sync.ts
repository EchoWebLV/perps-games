export interface LeverSync {
  /** record the newest desired leverage; drains in the background, coalescing to latest */
  submit(lev: number): void;
  /** true while a send is in flight or a value is queued */
  pending(): boolean;
}

/**
 * Single-flight, latest-wins. Guarantees at most one `send` in flight plus one pending
 * (= the newest value submitted). Values submitted during an in-flight send collapse to the
 * latest; a value equal to the last one actually sent is a no-op. A rejected send is swallowed
 * (the next submit re-drives), so a transient RPC error never wedges the queue.
 *
 * `lastSent` only advances on a RESOLVED send: a rejected send must never count as sent, or
 * re-submitting the same value dedups to a no-op and the leverage silently never reaches the
 * chain (and can carry stale into the next round). A failure leaves `lastSent` untouched so the
 * next submit — even of the same value — re-drives.
 */
export function createLeverSync(opts: { send: (lev: number) => Promise<void> }): LeverSync {
  let inFlight = false;
  let queued: number | null = null;
  let lastSent: number | null = null;

  async function drain(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    try {
      while (queued !== null && queued !== lastSent) {
        const target = queued;
        queued = null;          // a submit during the await below re-sets this to the newest
        try {
          await opts.send(target);
          lastSent = target;    // ONLY a resolved send counts as sent (a reject re-drives)
        } catch { /* swallow; leave lastSent so the next submit of this value retries */ }
      }
    } finally {
      inFlight = false;
    }
  }

  return {
    submit(lev) { queued = lev; void drain(); },
    pending: () => inFlight || queued !== null,
  };
}
