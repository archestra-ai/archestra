import type { ConnectivityState } from "./connectivity";

export function getConnectivityMessage(
  kind: Exclude<ConnectivityState["kind"], "online">,
  appName: string,
): { title: string; detail: string } {
  switch (kind) {
    case "browser-offline":
      return {
        title: "You're offline.",
        detail: "Reconnect to the internet, then retry.",
      };
    case "backend-unreachable":
      return {
        title: `Can't reach the ${appName} server.`,
        detail:
          "Check your connection. If it persists, ask an administrator to check the service.",
      };
    case "database-unavailable":
      return {
        title: "Database unavailable.",
        detail:
          "Ask an administrator to check the database service, connection settings, and capacity.",
      };
  }
}
