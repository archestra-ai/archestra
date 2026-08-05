import type { RemoteServerInstallResult } from "@/app/mcp/registry/_parts/remote-server-install-dialog";

export function buildRemoteInstallCredentialPayload(
  result: Pick<
    RemoteServerInstallResult,
    "metadata" | "isByosVault" | "browserKeyProtected"
  >,
) {
  const accessToken =
    !result.isByosVault &&
    typeof result.metadata?.access_token === "string" &&
    result.metadata.access_token.length > 0
      ? result.metadata.access_token
      : undefined;

  const userConfigValues = accessToken
    ? undefined
    : normalizeUserConfigValues(result.metadata);

  return {
    ...(accessToken ? { accessToken } : {}),
    ...(userConfigValues ? { userConfigValues } : {}),
    isByosVault: result.isByosVault,
    // Only sent when the user chose browser-key protection; the install and
    // reauthenticate mutations attach the credential-key header alongside.
    ...(result.browserKeyProtected ? { browserKeyProtected: true } : {}),
  };
}

function normalizeUserConfigValues(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) {
    return undefined;
  }

  const entries = Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, String(value)] as const);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}
