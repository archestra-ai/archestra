import { resolveInstallationCredential } from "@/integrations/github/app-auth";
import {
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { CredentialAccess } from "@/services/credential-access";
import { githubUserConnectionManager } from "@/services/github-user-connection";
import {
  ApiError,
  type McpCredentialBlocker,
  type RuntimeCredentialConnectionScope,
  type RuntimeCredentialDefinition,
} from "@/types";

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
  return resolveDefinedCredential(params, definition);
}

/** A definition snapshot belongs only to one launch or preflight operation. */
export class CredentialResolutionBatch {
  private constructor(
    private readonly organizationId: string,
    private readonly definitions: Map<string, RuntimeCredentialDefinition>,
  ) {}

  static async create(params: {
    organizationId: string;
    credentialIds: string[];
  }): Promise<CredentialResolutionBatch> {
    return new CredentialResolutionBatch(
      params.organizationId,
      await RuntimeCredentialDefinitionModel.findByKeys({
        organizationId: params.organizationId,
        keys: params.credentialIds,
      }),
    );
  }

  has(credentialId: string): boolean {
    return this.definitions.has(credentialId);
  }

  /** The credential's display name, falling back to its key. */
  name(credentialId: string): string {
    return this.definitions.get(credentialId)?.name ?? credentialId;
  }

  resolve(params: Parameters<typeof resolveCredential>[0]) {
    if (params.organizationId !== this.organizationId)
      throw new ApiError(400, "Credential is no longer available");
    return resolveDefinedCredential(
      params,
      this.definitions.get(params.credentialId) ?? null,
    );
  }
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
  const batch = await CredentialResolutionBatch.create({
    organizationId: params.organizationId,
    credentialIds: params.environment.flatMap((binding) =>
      binding.credentialId ? [binding.credentialId] : [],
    ),
  });
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
    const credential = await batch.resolve({
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
        describeMcpCredentialBlocker(
          await blockerForMissingValue({
            organizationId: params.organizationId,
            userId: params.userId,
            batch,
            binding: { ...binding, credentialId: binding.credentialId, scope },
          }),
        ),
      );
  }
  return { values, expiresAt };
}

/**
 * What would stop {@link resolveMcpCredentials} for this caller, found before
 * they press Install, so the dialog can say so instead of failing after.
 */
export async function preflightMcpCredentials(params: {
  organizationId: string;
  userId: string;
  installationScope: string;
  environment: Parameters<typeof resolveMcpCredentialValues>[0]["environment"];
}): Promise<McpCredentialBlocker[]> {
  const bindings = params.environment.flatMap((binding) =>
    binding.credentialId && binding.credentialScope && binding.required
      ? [
          {
            ...binding,
            credentialId: binding.credentialId,
            scope: binding.credentialScope,
          },
        ]
      : [],
  );
  const batch = await CredentialResolutionBatch.create({
    organizationId: params.organizationId,
    credentialIds: bindings.map((binding) => binding.credentialId),
  });
  const blockers: McpCredentialBlocker[] = [];
  for (const binding of bindings) {
    if (
      binding.scope === "personal" &&
      params.installationScope !== "personal"
    ) {
      blockers.push({
        envKey: binding.key,
        credentialId: binding.credentialId,
        credentialName: batch.name(binding.credentialId),
        reason: "personal_only",
      });
      continue;
    }
    const value = await batch
      .resolve({
        organizationId: params.organizationId,
        userId: params.userId,
        scope: binding.scope,
        credentialId: binding.credentialId,
      })
      .then(
        (credential) => credential?.value ?? null,
        () => null,
      );
    if (!value)
      blockers.push(
        await blockerForMissingValue({
          organizationId: params.organizationId,
          userId: params.userId,
          batch,
          binding,
        }),
      );
  }
  return blockers;
}

// === internals ===
/** The sentence an install refusal shows for one blocker. */
function describeMcpCredentialBlocker(
  blocker: McpCredentialBlocker,
): string {
  const name = `"${blocker.credentialName}"`;
  switch (blocker.reason) {
    case "no_access":
      return `This server needs the ${name} credential, and you don't have access to it. Ask an admin to share it with you.`;
    case "not_connected":
      return `This server needs your value for the ${name} credential. Add it in Settings → Credentials, then install again.`;
    case "not_set_up":
      return `This server needs the ${name} credential, which isn't set up for the organization yet. Ask an admin to set it up.`;
    case "personal_only":
      return `This server needs each person's own ${name} credential, so you can only install it for yourself.`;
  }
}

/**
 * Why a binding resolved to nothing. A personal value is the caller's to add
 * only when they may use the credential; an organization value is an admin's.
 */
async function blockerForMissingValue(params: {
  organizationId: string;
  userId: string | null;
  batch: CredentialResolutionBatch;
  binding: {
    key: string;
    credentialId: string;
    scope: "personal" | "organization";
  };
}): Promise<McpCredentialBlocker> {
  const { binding } = params;
  const blocker = {
    envKey: binding.key,
    credentialId: binding.credentialId,
    credentialName: params.batch.name(binding.credentialId),
  };
  if (
    binding.scope === "organization" ||
    !params.userId ||
    !params.batch.has(binding.credentialId)
  )
    return { ...blocker, reason: "not_set_up" };
  const usable = await CredentialAccess.usableKeys({
    organizationId: params.organizationId,
    userId: params.userId,
    keys: [binding.credentialId],
  });
  return {
    ...blocker,
    reason: usable.has(binding.credentialId) ? "not_connected" : "no_access",
  };
}

async function resolveDefinedCredential(
  params: Parameters<typeof resolveCredential>[0],
  definition: RuntimeCredentialDefinition | null,
): Promise<{ value: string; expiresAt: number | null } | null> {
  if (!definition) throw new ApiError(400, "Credential is no longer available");
  if (
    params.scope === "personal"
      ? !definition.allowPersonal
      : !definition.allowOrganization
  ) {
    throw new ApiError(400, "Credential ownership does not match this binding");
  }
  if (definition.kind === "github_app_user") {
    if (params.scope !== "personal" || !params.userId) return null;
    return githubUserConnectionManager.resolve({
      ...params,
      userId: params.userId,
    });
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
