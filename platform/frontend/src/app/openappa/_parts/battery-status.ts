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
