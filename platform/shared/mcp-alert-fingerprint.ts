export const MCP_SERVER_DISMISSIBLE_ALERT_KINDS = [
  "failed-to-start",
  "not-running",
  "needs-reauth",
] as const;

export type McpServerDismissibleAlertKind =
  (typeof MCP_SERVER_DISMISSIBLE_ALERT_KINDS)[number];

export function classifyMcpRuntimeAlert(params: {
  runtimeState?: string;
  runtimeError?: string | null;
  installationStatus?: string | null;
}): Exclude<McpServerDismissibleAlertKind, "needs-reauth"> | null {
  const installing =
    params.installationStatus === "pending" ||
    params.installationStatus === "discovering-tools";
  const installFailed = params.installationStatus === "error";

  if (params.runtimeState === "failed" || params.runtimeState === "succeeded") {
    return installing || installFailed ? "failed-to-start" : "not-running";
  }
  if (params.runtimeState === "not_created") {
    if (installFailed) return "failed-to-start";
    if (params.installationStatus === "success") return "not-running";
  }
  if (params.runtimeState === "pending" && params.runtimeError) {
    return "failed-to-start";
  }
  return installFailed ? "failed-to-start" : null;
}

export function createMcpServerAlertFingerprint(params: {
  kind: McpServerDismissibleAlertKind;
  catalogId: string;
  serverId?: string;
  source: unknown;
}): string {
  const source =
    params.source instanceof Date
      ? params.source.toISOString()
      : String(params.source);
  if (params.kind === "needs-reauth") {
    return `v1:needs-reauth:${source}`;
  }
  const input = JSON.stringify([
    params.kind,
    params.catalogId,
    params.serverId ?? null,
    source,
  ]);
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(index)) >>> 0;
  }
  return `v1:${params.kind}:${hash.toString(36)}`;
}

export function mcpRuntimeAlertSource(params: {
  serverId: string;
  deploymentName?: string;
  podName?: string;
  state?: string;
  error?: string | null;
  restartCount?: number;
}): string {
  return JSON.stringify({
    deployment: params.deploymentName ?? params.podName ?? params.serverId,
    state: params.state ?? "unknown",
    error: params.error ?? null,
    restartCount: params.restartCount ?? 0,
  });
}
