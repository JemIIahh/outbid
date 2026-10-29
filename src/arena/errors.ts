const MAX_REASON = 200;

/**
 * An error as one short line that is safe to put on the event feed. Network errors carry the RPC
 * address (often with a key in it) and the request body; the feed, the page and the recordings
 * are public, so web addresses are dropped and the rest is cut short.
 */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[address]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_REASON);
}
