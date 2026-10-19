import type { PolicyBattery } from "@/lib/openappa-batteries.query";
import type { BatteryTableStatus, EnforcedStatus } from "./battery-status";

/**
 * A battery's table status, from the status the current policy text gives it,
 * unless the enforced composition refuses it: then no rule of it is enforced.
 * An entry no package answers (`unavailable`) composes nothing, so it reads as
 * not configured here; the Policy page marks its line.
 */
export function batteryTableStatus(
  battery: PolicyBattery | null,
  enforced?: EnforcedStatus,
): BatteryTableStatus {
  if (!battery) return "not_configured";
  if (enforced === "refused") return "refused";
  switch (battery.status) {
    case "missing_credentials":
      return "credential";
    case "server_missing":
      return "server";
    case "naming_conflict":
      return "conflict";
    case "unavailable":
      return "not_configured";
    case "refused":
      return "refused";
    case "active":
    case "unrouted":
      return "configured";
  }
}

const ADD_VALUE = "Add the value in Settings › Credentials.";

/**
 * What a problem status means for this battery and where to fix it; null for a
 * status that needs nothing. Each case follows the backend check that sets it.
 */
export function batteryStatusHint(params: {
  battery: PolicyBattery | null;
  enforced?: EnforcedStatus;
  catalogName: (catalogId: string) => string;
}): string | null {
  const { battery, enforced, catalogName } = params;
  if (!battery) return null;
  const { credentials, servers } = battery;
  switch (batteryTableStatus(battery, enforced)) {
    case "refused":
      return "The policy was refused, so no rule of this battery is enforced. The Policy page shows the error.";
    case "credential": {
      if (credentials.some(({ key }) => key === null))
        return "Choose a credential for this battery. Open the battery and select one under Credentials.";
      return credentials.length === 1
        ? `The credential ${credentials[0].key} has no value for the organization. ${ADD_VALUE}`
        : `A credential of this battery has no value for the organization. ${ADD_VALUE}`;
    }
    case "server":
      return servers.length === 0
        ? "This battery is not attached to an MCP server. Open the battery and attach a server."
        : "The MCP server attached to this battery was uninstalled. Install it again, or open the battery and attach a different server.";
    case "conflict": {
      // A target more than one server carries resolves to no single catalog.
      const shared = servers.filter(({ catalogId }) => catalogId === null);
      if (shared.length > 0)
        return `More than one MCP server has the tool prefix ${shared
          .map(({ target }) => target)
          .join(", ")}. The battery cannot tell which server to check.`;
      const only = servers.length === 1 ? servers[0].catalogId : null;
      return only
        ? `The tools of ${catalogName(only)} have "__" in their prefix. Batteries cannot check these tools.`
        : 'The tools of an attached MCP server have "__" in their prefix. Batteries cannot check these tools.';
    }
    case "configured":
    case "not_configured":
      return null;
  }
}
