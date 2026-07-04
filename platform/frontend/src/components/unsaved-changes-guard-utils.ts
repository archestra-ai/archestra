import { isEqualWith } from "lodash-es";

/**
 * What to do when a guarded dialog's open state is about to change.
 * - `open`: the dialog is opening; let it through.
 * - `close`: the form is clean; close immediately.
 * - `confirm`: the form is dirty; ask the user before discarding.
 */
type CloseAttemptResolution = "open" | "close" | "confirm";

export function resolveCloseAttempt({
  nextOpen,
  isDirty,
}: {
  nextOpen: boolean;
  isDirty: boolean;
}): CloseAttemptResolution {
  if (nextOpen) {
    return "open";
  }
  return isDirty ? "confirm" : "close";
}

/**
 * Compares a form snapshot taken when the dialog opened against the current
 * snapshot. `null`, `undefined`, and `""` are treated as the same empty value
 * so a field loaded as `null` and bound to an empty input is not falsely dirty.
 */
export function hasUnsavedChanges(initial: unknown, current: unknown): boolean {
  return !isEqualWith(initial, current, emptyEquivalentComparer);
}

function emptyEquivalentComparer(a: unknown, b: unknown): boolean | undefined {
  if (isEmptyValue(a) && isEmptyValue(b)) {
    return true;
  }
  // Returning undefined defers to lodash's default deep comparison.
  return undefined;
}

function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}
