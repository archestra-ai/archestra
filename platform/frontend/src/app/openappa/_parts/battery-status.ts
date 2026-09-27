import type { PolicyBattery } from "@/lib/openappa-batteries.query";

type BatteryStatus = PolicyBattery["status"];

/** Shared status meaning; each surface chooses its own badge presentation. */
export const BATTERY_STATUS = {
  active: { label: "Active", severity: "ok" },
  missing_credentials: { label: "Needs a credential", severity: "critical" },
  naming_conflict: { label: "Tool name conflict", severity: "critical" },
  server_missing: { label: "No server bound", severity: "warning" },
  unrouted: { label: "Not used by any rule", severity: "warning" },
  refused: { label: "Not enforced", severity: "critical" },
  unavailable: { label: "Package missing", severity: "critical" },
} satisfies Record<
  BatteryStatus,
  { label: string; severity: "ok" | "warning" | "critical" }
>;

/**
 * The statuses grouped by what the reader does next: nothing, fix it, install
 * it, or browse it. Broken is every included battery that is not active; the
 * row's badge names the exact problem. The overview counts the same groups.
 */
export const BATTERY_STATUS_GROUPS = [
  { value: "active", label: "Active" },
  { value: "broken", label: "Broken" },
  { value: "fits", label: "Fits your servers" },
  { value: "other", label: "Other available" },
] as const;

export type BatteryStatusGroup =
  (typeof BATTERY_STATUS_GROUPS)[number]["value"];

/** The batteries page, filtered to one status group. */
export const batteriesHref = (group: BatteryStatusGroup) =>
  `/openappa/batteries?status=${group}`;
