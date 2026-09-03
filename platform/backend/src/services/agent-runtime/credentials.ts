import { isVaultReference } from "@archestra/shared";
import logger from "@/logging";
import {
  AgentModel,
  RuntimeCredentialConnectionModel,
  SecretModel,
  UserCredentialModel,
} from "@/models";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import {
  deleteRuntimeCredentialConnection,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import type {
  AgentRuntimeCredentialDeclaration,
  MissingAgentRuntimeCredential,
  ResolvedAgentRuntime,
} from "@/types";
import { ApiError } from "@/types";

/**
 * Outcome of resolving one Agent Runtime run's declared credentials for one user.
 *
 * `missing` and `misconfigured` are deliberately separate: the first lists
 * personal credentials the invoking user can supply themselves (and is what
 * the "connect your credentials" prompt is built from), the second lists
 * shared credentials only an administrator can fix. Collapsing them would ask
 * a user to provide something they have no way to provide.
 */
type AgentRuntimeCredentialResolution = {
  env: Record<string, string>;
  missing: MissingAgentRuntimeCredential[];
  misconfigured: MissingAgentRuntimeCredential[];
};

/**
 * Resolve every credential an Agent Runtime run declares into environment variables for a
 * Agent Runtime run started by `userId`, reporting anything absent instead of injecting a
 * blank value — an agent handed an empty token fails far from the cause.
 */
export async function resolveAgentRuntimeCredentials(params: {
  runtime: Pick<ResolvedAgentRuntime, "agentId" | "credentials" | "secretId">;
  organizationId: string;
  userId: string | null;
}): Promise<AgentRuntimeCredentialResolution> {
  const { shared, perUser } = splitDeclarations(params.runtime.credentials);
  const env: Record<string, string> = {};
  const missing: MissingAgentRuntimeCredential[] = [];
  const misconfigured: MissingAgentRuntimeCredential[] = [];

  if (shared.length > 0) {
    const bag = await readSharedBag(params.runtime.secretId);
    for (const declaration of shared) {
      const value = declaration.credentialId
        ? await RuntimeCredentialConnectionModel.resolveValue({
            organizationId: params.organizationId,
            scope: "organization",
            credentialId: declaration.credentialId,
          })
        : bag[declaration.key];
      if (typeof value === "string" && value.length > 0) {
        env[declaration.key] = value;
      } else if (declaration.required) {
        misconfigured.push(toMissing(declaration));
      }
    }
  }

  if (perUser.length > 0) {
    if (!params.userId) {
      return {
        env,
        missing: perUser.filter((entry) => entry.required).map(toMissing),
        misconfigured,
      };
    }
    const legacyDeclarations = perUser.filter(
      (declaration) => !declaration.credentialId,
    );
    const resolved = await UserCredentialModel.resolveValues({
      organizationId: params.organizationId,
      userId: params.userId,
      agentId: params.runtime.agentId,
      keys: legacyDeclarations.map((declaration) => declaration.key),
    });
    Object.assign(env, resolved.values);
    for (const declaration of perUser) {
      const value = declaration.credentialId
        ? await RuntimeCredentialConnectionModel.resolveValue({
            organizationId: params.organizationId,
            scope: "personal",
            userId: params.userId,
            credentialId: declaration.credentialId,
          })
        : resolved.values[declaration.key];
      if (value) {
        env[declaration.key] = value;
      } else if (declaration.required) {
        missing.push(toMissing(declaration));
      }
    }
  }

  return { env, missing, misconfigured };
}

/**
 * The same answer without reading any secret material: used to annotate the
 * UI before a user asks for an Agent Runtime run, so a start button can say what is needed
 * rather than failing on click.
 */
export async function preflightAgentRuntimeCredentials(params: {
  runtime: Pick<ResolvedAgentRuntime, "agentId" | "credentials" | "secretId">;
  organizationId: string;
  userId: string | null;
}): Promise<{
  configured: string[];
  missing: MissingAgentRuntimeCredential[];
  misconfigured: MissingAgentRuntimeCredential[];
}> {
  const { shared, perUser } = splitDeclarations(params.runtime.credentials);
  const configured: string[] = [];
  const missing: MissingAgentRuntimeCredential[] = [];
  const misconfigured: MissingAgentRuntimeCredential[] = [];

  if (shared.length > 0) {
    const bag = await readSharedBag(params.runtime.secretId);
    for (const declaration of shared) {
      const value = declaration.credentialId
        ? await RuntimeCredentialConnectionModel.resolveValue({
            organizationId: params.organizationId,
            scope: "organization",
            credentialId: declaration.credentialId,
          })
        : bag[declaration.key];
      if (typeof value === "string" && value.length > 0) {
        configured.push(declaration.key);
      } else if (declaration.required) {
        misconfigured.push(toMissing(declaration));
      }
    }
  }

  if (perUser.length > 0) {
    if (!params.userId) {
      missing.push(...perUser.filter((entry) => entry.required).map(toMissing));
      return { configured, missing, misconfigured };
    }
    const legacyDeclarations = perUser.filter(
      (declaration) => !declaration.credentialId,
    );
    const present = await UserCredentialModel.listPresentKeys({
      organizationId: params.organizationId,
      userId: params.userId,
      agentId: params.runtime.agentId,
      keys: legacyDeclarations.map((declaration) => declaration.key),
    });
    for (const declaration of perUser) {
      const connected = declaration.credentialId
        ? Boolean(
            await RuntimeCredentialConnectionModel.resolveValue({
              organizationId: params.organizationId,
              scope: "personal",
              userId: params.userId,
              credentialId: declaration.credentialId,
            }),
          )
        : present.has(declaration.key);
      if (connected) {
        configured.push(declaration.key);
      } else if (declaration.required) {
        missing.push(toMissing(declaration));
      }
    }
  }

  return { configured, missing, misconfigured };
}

/**
 * Store one declared credential at the scope chosen by the Agent Runtime configuration.
 * A read-only Vault runtime expects `value` to be a `path#key` reference;
 * the configured secrets manager resolves it only when a session launches.
 */
export async function setAgentRuntimeCredential(params: {
  runtime: ResolvedAgentRuntime;
  organizationId: string;
  userId: string;
  key: string;
  value: string;
}): Promise<{ scope: AgentRuntimeCredentialDeclaration["scope"] }> {
  const declaration = requireDeclaration(params.runtime, params.key);
  assertCredentialValue(params.value);

  if (declaration.scope === "per_user") {
    if (declaration.credentialId) {
      await setRuntimeCredentialConnection({
        organizationId: params.organizationId,
        scope: "personal",
        userId: params.userId,
        credentialId: declaration.credentialId,
        value: params.value,
      });
    } else {
      await UserCredentialModel.upsert({
        organizationId: params.organizationId,
        userId: params.userId,
        agentId: params.runtime.agentId,
        key: declaration.key,
        value: params.value,
      });
    }
  } else {
    if (declaration.credentialId) {
      await setRuntimeCredentialConnection({
        organizationId: params.organizationId,
        scope: "organization",
        userId: params.userId,
        credentialId: declaration.credentialId,
        value: params.value,
      });
    } else {
      await replaceSharedBag({
        runtime: params.runtime,
        patch: { [declaration.key]: params.value },
      });
    }
  }

  return { scope: declaration.scope };
}

/** Remove only this Agent Runtime run's value; declarations remain part of its config. */
export async function deleteAgentRuntimeCredential(params: {
  runtime: ResolvedAgentRuntime;
  organizationId: string;
  userId: string;
  key: string;
}): Promise<{
  deleted: boolean;
  scope: AgentRuntimeCredentialDeclaration["scope"];
}> {
  const declaration = requireDeclaration(params.runtime, params.key);
  if (declaration.credentialId) {
    return {
      scope: declaration.scope,
      deleted: await deleteRuntimeCredentialConnection({
        organizationId: params.organizationId,
        scope: declaration.scope === "per_user" ? "personal" : "organization",
        userId: params.userId,
        credentialId: declaration.credentialId,
      }),
    };
  }
  if (declaration.scope === "per_user") {
    return {
      scope: declaration.scope,
      deleted: await UserCredentialModel.delete({
        organizationId: params.organizationId,
        userId: params.userId,
        agentId: params.runtime.agentId,
        key: declaration.key,
      }),
    };
  }

  const bag = await readRawSharedBag(params.runtime.secretId);
  if (!(declaration.key in bag)) {
    return { scope: declaration.scope, deleted: false };
  }
  const { [declaration.key]: _removed, ...remaining } = bag;
  await replaceSharedBag({ runtime: params.runtime, values: remaining });
  return { scope: declaration.scope, deleted: true };
}

// ===================== internals =====================

function splitDeclarations(
  declarations: AgentRuntimeCredentialDeclaration[] | null | undefined,
): {
  shared: AgentRuntimeCredentialDeclaration[];
  perUser: AgentRuntimeCredentialDeclaration[];
} {
  const shared: AgentRuntimeCredentialDeclaration[] = [];
  const perUser: AgentRuntimeCredentialDeclaration[] = [];
  for (const declaration of declarations ?? []) {
    if (declaration.scope === "per_user") {
      perUser.push(declaration);
    } else {
      shared.push(declaration);
    }
  }
  return { shared, perUser };
}

function requireDeclaration(
  runtime: Pick<ResolvedAgentRuntime, "credentials">,
  key: string,
): AgentRuntimeCredentialDeclaration {
  const declaration = runtime.credentials?.find((entry) => entry.key === key);
  if (!declaration) {
    throw new ApiError(
      404,
      "Credential is not declared by this Agent's Agent Runtime configuration",
    );
  }
  return declaration;
}

function assertCredentialValue(value: string): void {
  if (!isByosEnabled()) return;
  if (!isVaultReference(value)) {
    throw new ApiError(
      400,
      "Readonly Vault credentials must select a secret and key",
    );
  }
}

async function replaceSharedBag(params: {
  runtime: ResolvedAgentRuntime;
  patch?: Record<string, string>;
  values?: Record<string, unknown>;
}): Promise<void> {
  const previousId = params.runtime.secretId;
  const previous = params.values ?? (await readRawSharedBag(previousId));
  const next = { ...previous, ...params.patch };
  if (Object.keys(next).length === 0) {
    const updated = await AgentModel.setAgentRuntimeSecretId({
      id: params.runtime.agentId,
      secretId: null,
    });
    if (!updated) {
      throw new ApiError(
        500,
        "Agent disappeared while clearing runtime credentials",
      );
    }
    if (previousId) await deleteSecretQuietly(previousId);
    return;
  }
  const created = await secretManager().createSecret(
    next,
    `agent-${params.runtime.agentId}-runtime-credentials`,
  );
  try {
    const updated = await AgentModel.setAgentRuntimeSecretId({
      id: params.runtime.agentId,
      secretId: created.id,
    });
    if (!updated) {
      throw new ApiError(
        500,
        "Agent disappeared while updating runtime credentials",
      );
    }
  } catch (error) {
    await deleteSecretQuietly(created.id);
    throw error;
  }
  if (previousId) await deleteSecretQuietly(previousId);
}

async function readRawSharedBag(
  secretId: string | null,
): Promise<Record<string, unknown>> {
  if (!secretId) return {};
  const secret = await SecretModel.findById(secretId);
  return secret?.secret ?? {};
}

async function readSharedBag(
  secretId: string | null,
): Promise<Record<string, unknown>> {
  if (!secretId) {
    return {};
  }
  const secret = await secretManager().getSecret(secretId);
  if (!secret) {
    // The bag was deleted out from under the Agent. Reported per-key as
    // misconfigured by the callers above rather than thrown here, so the
    // response can name every credential an administrator has to restore.
    logger.warn(
      { secretId },
      "Agent Runtime credential bag is missing from the secrets manager",
    );
    return {};
  }
  return secret.secret ?? {};
}

function toMissing(
  declaration: AgentRuntimeCredentialDeclaration,
): MissingAgentRuntimeCredential {
  return {
    key: declaration.key,
    credentialId: declaration.credentialId,
    label: declaration.label,
    description: declaration.description,
  };
}

async function deleteSecretQuietly(secretId: string): Promise<void> {
  try {
    await secretManager().deleteSecret(secretId);
  } catch (error) {
    logger.warn(
      { error, secretId },
      "Failed to delete replaced Agent Runtime credential secret",
    );
  }
}
