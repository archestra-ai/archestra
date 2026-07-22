/**
 * Pure dialog-choice logic for the per-install Reinstall flow.
 *
 * A flagged install carries a persisted `reinstallReason`:
 *   - "new-input": the catalog's prompted schema changed — the install owes
 *     values it doesn't have, so the install dialog must collect them.
 *   - "restart": stored values are still valid (execution-config drift,
 *     retry after a failed sync) — a plain confirm suffices; the backend's
 *     empty-body reinstall reuses the stored secret bag.
 *
 * BYOS vault is the exception: vault references are re-supplied on every
 * reinstall (never persisted server-side), so an empty-body reinstall of a
 * catalog with secret-bearing prompted fields would 400 — those always get
 * the collecting dialog.
 *
 * Missing/unknown reasons fall back to collecting input — the conservative
 * path that matches pre-reason behavior.
 */

export type ReinstallDialogKind = "collect-input" | "confirm";

export function decideReinstallDialog(params: {
  /** Catalog has any install-prompted field the dialog would render. */
  hasPromptedFields: boolean;
  /** BYOS vault active AND the catalog has secret/sensitive prompted fields. */
  byosCollectsSecrets: boolean;
  flaggedInstalls: Array<{
    reinstallRequired: boolean;
    reinstallReason?: "new-input" | "restart" | null;
  }>;
}): ReinstallDialogKind {
  const { hasPromptedFields, byosCollectsSecrets, flaggedInstalls } = params;
  if (!hasPromptedFields) return "confirm";
  if (byosCollectsSecrets) return "collect-input";
  const allRestartOnly =
    flaggedInstalls.length > 0 &&
    flaggedInstalls.every(
      (s) => s.reinstallRequired && s.reinstallReason === "restart",
    );
  return allRestartOnly ? "confirm" : "collect-input";
}
