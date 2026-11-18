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
 * Why a battery's rules are not in force, for someone who has not read how
 * batteries work, and what the way out is called. Nothing for one in force.
 */
export const BATTERY_PROBLEM = {
  missing_credentials: {
    text: "These rules are off. This battery looks things up with an API token to make its checks, and none is chosen yet.",
    action: "Choose a credential",
  },
  server_missing: {
    text: "These rules are off. This battery is not linked to any of your MCP servers, so it has no tool calls to check.",
    action: "Link a server",
  },
  naming_conflict: {
    text: "These rules are off. The battery cannot tell which MCP server's tools it should check.",
    action: "See why",
  },
  unrouted: {
    text: "These rules are not used. Nothing in your policy sends this battery's tools through them.",
    action: "Open battery",
  },
  refused: {
    text: "These rules are off. The policy that includes this battery was refused, so an earlier policy is still in force.",
    action: "Open battery",
  },
  unavailable: {
    text: "These rules are off. The battery's package is missing.",
    action: "Open battery",
  },
  pending: {
    text: "These rules are not live yet. An earlier version of the policy is still the one in force.",
    action: "Open battery",
  },
} satisfies Record<
  Exclude<EnforcedStatus, "active">,
  { text: string; action: string }
>;

/**
 * What the Batteries table says about one battery: whether the policy includes
 * it and, when it does, what it still needs. A refusal or a pending revision is
 * a fact about the policy, not about one battery, so the table never shows it.
 */
export type BatteryTableStatus =
  | "configured"
  | "credential"
  | "server"
  | "conflict"
  | "not_configured";

export const BATTERY_TABLE_STATUS = {
  configured: { label: "Configured", group: "configured" },
  credential: { label: "Credential not configured", group: "attention" },
  server: { label: "Server not configured", group: "attention" },
  conflict: { label: "Server conflict", group: "attention" },
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
