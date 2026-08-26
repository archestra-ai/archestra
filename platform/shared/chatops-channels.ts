/**
 * Longest per-channel instruction text an admin may save for a messaging
 * channel binding. Generous enough for a paragraph or two of channel-specific
 * policy, small enough that it cannot crowd out the message it is delivered
 * with.
 *
 * Shared so the backend's validation and the editor's character counter agree
 * — a UI that lets someone type past the limit only to have the save rejected
 * is worse than one that stops them.
 */
export const CHANNEL_INSTRUCTIONS_MAX_LENGTH = 4000;
