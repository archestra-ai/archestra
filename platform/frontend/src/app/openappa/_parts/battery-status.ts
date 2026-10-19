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
 * What the Batteries table says about one battery: whether the policy includes
 * it and, when it does, what it still needs, or that a refused policy enforces
 * none of its rules.
 */
export type BatteryTableStatus =
  | "configured"
  | "credential"
  | "server"
  | "conflict"
  | "refused"
  | "not_configured";

export const BATTERY_TABLE_STATUS = {
  configured: { label: "Configured", group: "configured" },
  credential: { label: "Credential not configured", group: "attention" },
  server: { label: "Server not configured", group: "attention" },
  conflict: { label: "Server conflict", group: "attention" },
  refused: { label: "Refused by policy", group: "attention" },
  not_configured: { label: "Not configured", group: "not_configured" },
} as const satisfies Record<
  BatteryTableStatus,
  { label: string; group: BatteryStatusGroup }
>;

/** The status filter's options; Needs attention covers every problem status. */
export const BATTERY_STATUS_GROUPS = [
  { value: "configured", label: "Configured" },
  { value: "attention", label: "Needs attention" },
  { value: "not_configured", label: "Not configured" },
] as const;

export type BatteryStatusGroup =
  (typeof BATTERY_STATUS_GROUPS)[number]["value"];

/** The batteries page, filtered to one status group. */
export const batteriesHref = (group: BatteryStatusGroup) =>
  `/openappa/batteries?status=${group}`;
