export const MCP_SERVER_DISMISSIBLE_ALERT_KINDS = [
  "failed-to-start",
  "not-running",
  "needs-reauth",
  "reinstall-required",
  "awaiting-approval",
  "stuck-starting",
] as const;

export type McpServerDismissibleAlertKind =
  (typeof MCP_SERVER_DISMISSIBLE_ALERT_KINDS)[number];

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
