import { isVaultReference } from "@archestra/shared";
import logger from "@/logging";
import {
  AgentModel,
  ExecutionCredentialConnectionModel,
  SecretModel,
  UserCredentialModel,
} from "@/models";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import {
  deleteExecutionCredentialConnection,
  setExecutionCredentialConnection,
} from "@/services/runners/execution-credentials";
import type {
  AgentDeployment,
  AgentDeploymentCredentialDeclaration,
  MissingAgentDeploymentCredential,
} from "@/types";
import { ApiError } from "@/types";

/**
 * Outcome of resolving one runner's declared credentials for one user.
 *
 * `missing` and `misconfigured` are deliberately separate: the first lists
 * personal credentials the invoking user can supply themselves (and is what
 * the "connect your credentials" prompt is built from), the second lists
 * shared credentials only an administrator can fix. Collapsing them would ask
 * a user to provide something they have no way to provide.
 */
type AgentDeploymentCredentialResolution = {
  env: Record<string, string>;
  missing: MissingAgentDeploymentCredential[];
  misconfigured: MissingAgentDeploymentCredential[];
};

/**
 * Resolve every credential a runner declares into environment variables for a
 * runner started by `userId`, reporting anything absent instead of injecting a
 * blank value — an agent handed an empty token fails far from the cause.
 */
export async function resolveAgentDeploymentCredentials(params: {
  deployment: Pick<AgentDeployment, "agentId" | "credentials" | "secretId">;
  organizationId: string;
  userId: string | null;
}): Promise<AgentDeploymentCredentialResolution> {
  const { shared, perUser } = splitDeclarations(params.deployment.credentials);
  const env: Record<string, string> = {};
  const missing: MissingAgentDeploymentCredential[] = [];
  const misconfigured: MissingAgentDeploymentCredential[] = [];

  if (shared.length > 0) {
    const bag = await readSharedBag(params.deployment.secretId);
    for (const declaration of shared) {
      const value = declaration.credentialId
        ? await ExecutionCredentialConnectionModel.resolveValue({
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
      agentId: params.deployment.agentId,
      keys: legacyDeclarations.map((declaration) => declaration.key),
    });
    Object.assign(env, resolved.values);
    for (const declaration of perUser) {
      const value = declaration.credentialId
        ? await ExecutionCredentialConnectionModel.resolveValue({
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
 * UI before a user asks for a runner, so a start button can say what is needed
 * rather than failing on click.
 */
export async function preflightAgentDeploymentCredentials(params: {
  deployment: Pick<AgentDeployment, "agentId" | "credentials" | "secretId">;
  organizationId: string;
  userId: string | null;
}): Promise<{
  configured: string[];
  missing: MissingAgentDeploymentCredential[];
  misconfigured: MissingAgentDeploymentCredential[];
}> {
  const { shared, perUser } = splitDeclarations(params.deployment.credentials);
  const configured: string[] = [];
  const missing: MissingAgentDeploymentCredential[] = [];
  const misconfigured: MissingAgentDeploymentCredential[] = [];

  if (shared.length > 0) {
    const bag = await readSharedBag(params.deployment.secretId);
    for (const declaration of shared) {
      const value = declaration.credentialId
        ? await ExecutionCredentialConnectionModel.resolveValue({
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
      agentId: params.deployment.agentId,
      keys: legacyDeclarations.map((declaration) => declaration.key),
    });
    for (const declaration of perUser) {
      const connected = declaration.credentialId
        ? Boolean(
            await ExecutionCredentialConnectionModel.resolveValue({
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
 * Store one declared credential at the scope chosen by the runner definition.
 * A read-only Vault deployment expects `value` to be a `path#key` reference;
 * the configured secrets manager resolves it only when a session launches.
 */
export async function setAgentDeploymentCredential(params: {
  deployment: AgentDeployment;
  organizationId: string;
  userId: string;
  key: string;
  value: string;
}): Promise<{ scope: AgentDeploymentCredentialDeclaration["scope"] }> {
  const declaration = requireDeclaration(params.deployment, params.key);
  assertCredentialValue(params.value);

  if (declaration.scope === "per_user") {
    if (declaration.credentialId) {
      await setExecutionCredentialConnection({
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
        agentId: params.deployment.agentId,
        key: declaration.key,
        value: params.value,
      });
    }
  } else {
    if (declaration.credentialId) {
      await setExecutionCredentialConnection({
        organizationId: params.organizationId,
        scope: "organization",
        userId: params.userId,
        credentialId: declaration.credentialId,
        value: params.value,
      });
    } else {
      await replaceSharedBag({
        deployment: params.deployment,
        patch: { [declaration.key]: params.value },
      });
    }
  }

  return { scope: declaration.scope };
}

/** Remove only this runner's value; declarations remain part of its config. */
export async function deleteAgentDeploymentCredential(params: {
  deployment: AgentDeployment;
  organizationId: string;
  userId: string;
  key: string;
}): Promise<{
  deleted: boolean;
  scope: AgentDeploymentCredentialDeclaration["scope"];
}> {
  const declaration = requireDeclaration(params.deployment, params.key);
  if (declaration.credentialId) {
    return {
      scope: declaration.scope,
      deleted: await deleteExecutionCredentialConnection({
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
        agentId: params.deployment.agentId,
        key: declaration.key,
      }),
    };
  }

  const bag = await readRawSharedBag(params.deployment.secretId);
  if (!(declaration.key in bag)) {
    return { scope: declaration.scope, deleted: false };
  }
  const { [declaration.key]: _removed, ...remaining } = bag;
  await replaceSharedBag({ deployment: params.deployment, values: remaining });
  return { scope: declaration.scope, deleted: true };
}

// ===================== internals =====================

function splitDeclarations(
  declarations: AgentDeploymentCredentialDeclaration[] | null | undefined,
): {
  shared: AgentDeploymentCredentialDeclaration[];
  perUser: AgentDeploymentCredentialDeclaration[];
} {
  const shared: AgentDeploymentCredentialDeclaration[] = [];
  const perUser: AgentDeploymentCredentialDeclaration[] = [];
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
  deployment: Pick<AgentDeployment, "credentials">,
  key: string,
): AgentDeploymentCredentialDeclaration {
  const declaration = deployment.credentials?.find(
    (entry) => entry.key === key,
  );
  if (!declaration) {
    throw new ApiError(
      404,
      "Credential is not declared by this Agent's Background execution configuration",
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
  deployment: AgentDeployment;
  patch?: Record<string, string>;
  values?: Record<string, unknown>;
}): Promise<void> {
  const previousId = params.deployment.secretId;
  const previous = params.values ?? (await readRawSharedBag(previousId));
  const next = { ...previous, ...params.patch };
  if (Object.keys(next).length === 0) {
    const updated = await AgentModel.setBackgroundExecutionSecretId({
      id: params.deployment.agentId,
      secretId: null,
    });
    if (!updated) {
      throw new ApiError(
        500,
        "Agent disappeared while clearing deployment credentials",
      );
    }
    if (previousId) await deleteSecretQuietly(previousId);
    return;
  }
  const created = await secretManager().createSecret(
    next,
    `agent-${params.deployment.agentId}-deployment-credentials`,
  );
  try {
    const updated = await AgentModel.setBackgroundExecutionSecretId({
      id: params.deployment.agentId,
      secretId: created.id,
    });
    if (!updated) {
      throw new ApiError(
        500,
        "Agent disappeared while updating deployment credentials",
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
      "Agent Background execution credential bag is missing from the secrets manager",
    );
    return {};
  }
  return secret.secret ?? {};
}

function toMissing(
  declaration: AgentDeploymentCredentialDeclaration,
): MissingAgentDeploymentCredential {
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
      "Failed to delete replaced Agent Background execution credential secret",
    );
  }
}
