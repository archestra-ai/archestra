import type { PolicyBattery } from "@/lib/openappa-batteries.query";

/**
 * A battery's status as the composition the runtime enforces holds it.
 * `pending`: an earlier composition stays enforced, and it did not hold the
 * battery, which the current text declares.
 */
export type EnforcedStatus = PolicyBattery["status"] | "pending";

/** Shared status meaning; each surface chooses its own badge presentation. */
export const BATTERY_STATUS = {
  active: { label: "Enforced", severity: "ok" },
  missing_credentials: { label: "Needs a credential", severity: "critical" },
  naming_conflict: { label: "Tool name conflict", severity: "critical" },
  server_missing: { label: "No server set", severity: "warning" },
  unrouted: { label: "Not used by any rule", severity: "warning" },
  refused: { label: "Refused by policy", severity: "critical" },
  unavailable: { label: "Package missing", severity: "critical" },
  pending: { label: "Not yet enforced", severity: "warning" },
} satisfies Record<
  EnforcedStatus,
  { label: string; severity: "ok" | "warning" | "critical" }
>;

/**
 * The statuses grouped by what the reader does next: nothing, fix it, install
 * it, or browse it. Not enforced is every included battery that is not active; the
 * row's badge names the exact problem. The overview counts the same groups.
 */
export const BATTERY_STATUS_GROUPS = [
  { value: "active", label: "Enforced" },
  { value: "broken", label: "Not enforced" },
  { value: "fits", label: "Fits your servers" },
  { value: "other", label: "For other servers" },
] as const;

export type BatteryStatusGroup =
  (typeof BATTERY_STATUS_GROUPS)[number]["value"];

/** The batteries page, filtered to one status group. */
export const batteriesHref = (group: BatteryStatusGroup) =>
  `/openappa/batteries?status=${group}`;
