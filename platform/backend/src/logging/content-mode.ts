import type { LogContentMode } from "@archestra/shared";

/** Shared with config, without importing config back into its own logger. */
export function parseLogContentMode(
  value?: string,
  onInvalid?: () => void,
): LogContentMode {
  const normalized = value?.toLowerCase().trim();
  if (!normalized || normalized === "full") return "full";
  if (normalized !== "metadata_only") onInvalid?.();
  return "metadata_only";
}
