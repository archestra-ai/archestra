/**
 * Inline MCP App cards grow to their full reported content height: the guest
 * reports its natural height and the card sizes to it, letting the conversation
 * scroll handle tall apps rather than clipping them inline.
 */

/** Height an inline app paints at before its first size report. */
export const INITIAL_INLINE_HEIGHT = 320;
