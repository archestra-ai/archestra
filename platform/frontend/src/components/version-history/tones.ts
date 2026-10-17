/**
 * The commit-graph palette the version history dialogs share. Neutral surfaces
 * come from the theme tokens (`primary`, `muted`, `border`, `destructive`);
 * these are the few accents a terminal-style log adds on top of them, each
 * with its dark-mode reading beside it so the two never drift apart.
 */

/** Short content hashes, the way `git log --oneline` tints them. */
export const HASH_TEXT = "text-amber-700 dark:text-amber-300/85";

/** Insertions: `+` lines, added items, the green half of a diffstat. */
export const ADDED_TEXT = "text-emerald-700 dark:text-emerald-400";

/** The `@@` markers around a hunk's name. */
export const HUNK_MARKER_TEXT = "text-sky-700/80 dark:text-sky-400/80";
