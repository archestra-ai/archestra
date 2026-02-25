/**
 * Centralized keyboard shortcut definitions.
 *
 * Each shortcut defines:
 *  - `key`   – the `event.key` value used for matching (lowercase)
 *  - `code`  – the `event.code` value, needed when `event.key` is unreliable
 *              (e.g. macOS dead keys like Option+N produce event.key "Dead")
 *  - `label` – uppercase display label for the shortcut legend / UI
 */

/** Cmd/Ctrl + K — toggle search palette */
export const SHORTCUT_SEARCH = {
  key: "k",
  label: "K",
} as const;

/** Alt/Opt + N — new chat */
export const SHORTCUT_NEW_CHAT = {
  code: "KeyN",
  label: "N",
} as const;

/** D — delete conversation (press twice to confirm) */
export const SHORTCUT_DELETE = {
  key: "d",
  label: "D",
} as const;

/** P — pin/unpin conversation */
export const SHORTCUT_PIN = {
  key: "p",
  label: "P",
} as const;

/** Cmd/Ctrl + B — toggle sidebar */
export const SHORTCUT_SIDEBAR = {
  key: "b",
  label: "B",
} as const;
