export type ReinstallDialogKind = "collect-input" | "confirm";

export function decideReinstallDialog(params: {
  /** Catalog has any install-prompted field the dialog would render. */
  hasPromptedFields: boolean;

  flaggedInstalls: Array<{
    reinstallRequired: boolean;
    reinstallReason?: "new-input" | "restart" | null;
  }>;
}): ReinstallDialogKind {
  const { hasPromptedFields, flaggedInstalls } = params;
  if (!hasPromptedFields) return "confirm";

  const allRestartOnly =
    flaggedInstalls.length > 0 &&
    flaggedInstalls.every(
      (s) => s.reinstallRequired && s.reinstallReason === "restart",
    );
  return allRestartOnly ? "confirm" : "collect-input";
}
