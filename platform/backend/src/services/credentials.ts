import { resolveInstallationCredential } from "@/integrations/github/app-auth";
import {
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { ApiError, type RuntimeCredentialConnectionScope } from "@/types";

/** Resolve a reusable credential for its explicit owner at the point of use. */
export async function resolveCredentialValue(params: {
  organizationId: string;
  credentialId: string;
  scope: RuntimeCredentialConnectionScope;
  userId?: string | null;
  minimumValidityMs?: number;
}): Promise<string | null> {
  return (await resolveCredential(params))?.value ?? null;
}

/** The provider's expiry accompanies every renewable workload value. */
export async function resolveCredential(params: {
  organizationId: string;
  credentialId: string;
  scope: RuntimeCredentialConnectionScope;
  userId?: string | null;
  minimumValidityMs?: number;
}): Promise<{ value: string; expiresAt: number | null } | null> {
  const definition = await RuntimeCredentialDefinitionModel.find({
    organizationId: params.organizationId,
    key: params.credentialId,
  });
  if (!definition) throw new ApiError(400, "Credential is no longer available");
  if (
    params.scope === "personal"
      ? !definition.allowPersonal
      : !definition.allowOrganization
  ) {
    throw new ApiError(400, "Credential ownership does not match this binding");
  }
  const value = await RuntimeCredentialConnectionModel.resolveValue(params);
  if (!value) return null;
  if (definition.kind !== "github_app") return { value, expiresAt: null };
  if (
    !definition.githubUrl ||
    !definition.appId ||
    !definition.installationId
  ) {
    throw new ApiError(
      400,
      "GitHub App credential is missing its app or installation configuration",
    );
  }
  const token = await resolveInstallationCredential({
    githubUrl: definition.githubUrl,
    appId: definition.appId,
    installationId: definition.installationId,
    privateKey: value,
    minimumValidityMs: params.minimumValidityMs,
  });
  return { value: token.token, expiresAt: token.expiresAt };
}

/** Personal secrets may only enter a personally owned MCP process. */
export async function resolveMcpCredentialValues(params: {
  organizationId: string;
  userId: string | null;
  installationScope: string;
  environment: readonly {
    key: string;
    type: string;
    credentialId?: string;
    credentialScope?: "personal" | "organization";
    promptOnInstallation: boolean;
    required?: boolean;
  }[];
}): Promise<Record<string, string>> {
  return (await resolveMcpCredentials(params)).values;
}

export async function resolveMcpCredentials(
  params: Parameters<typeof resolveMcpCredentialValues>[0],
): Promise<{ values: Record<string, string>; expiresAt: number | null }> {
  const values: Record<string, string> = {};
  let expiresAt: number | null = null;
  for (const binding of params.environment) {
    if (!binding.credentialId) continue;
    if (binding.type !== "secret")
      throw new ApiError(
        400,
        "Saved credentials must use the secret environment variable type",
      );
    const scope = binding.credentialScope;
    if (!scope)
      throw new ApiError(
        400,
        "Saved credentials require an explicit ownership scope",
      );
    if (
      scope === "personal" &&
      (params.installationScope !== "personal" || !params.userId)
    ) {
      throw new ApiError(
        400,
        "A personal credential requires a personal MCP installation",
      );
    }
    const credential = await resolveCredential({
      organizationId: params.organizationId,
      userId: params.userId,
      scope,
      credentialId: binding.credentialId,
      minimumValidityMs: 50 * 60_000,
    });
    const value = credential?.value;
    if (credential?.expiresAt)
      expiresAt = Math.min(expiresAt ?? Infinity, credential.expiresAt);
    if (value) values[binding.key] = value;
    else if (binding.required)
      throw new ApiError(
        400,
        `Connect the credential for ${binding.key} in Settings → Credentials before installing this server`,
      );
  }
  return { values, expiresAt };
}
