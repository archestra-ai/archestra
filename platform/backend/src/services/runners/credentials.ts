import logger from "@/logging";
import { UserCredentialModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import type {
  MissingRunnerCredential,
  Runner,
  RunnerCredentialDeclaration,
} from "@/types";

/**
 * Outcome of resolving one agent's declared credentials for one user.
 *
 * `missing` and `misconfigured` are deliberately separate: the first lists
 * personal credentials the invoking user can supply themselves (and is what
 * the "connect your credentials" prompt is built from), the second lists
 * shared credentials only an administrator can fix. Collapsing them would ask
 * a user to provide something they have no way to provide.
 */
type RunnerCredentialResolution = {
  env: Record<string, string>;
  missing: MissingRunnerCredential[];
  misconfigured: MissingRunnerCredential[];
};

/**
 * Resolve every credential an agent declares into environment variables for a
 * runner started by `userId`, reporting anything absent instead of injecting a
 * blank value — an agent handed an empty token fails far from the cause.
 */
export async function resolveRunnerCredentials(params: {
  runner: Pick<Runner, "id" | "credentials" | "secretId">;
  organizationId: string;
  userId: string;
}): Promise<RunnerCredentialResolution> {
  const { shared, perUser } = splitDeclarations(params.runner.credentials);
  const env: Record<string, string> = {};
  const missing: MissingRunnerCredential[] = [];
  const misconfigured: MissingRunnerCredential[] = [];

  if (shared.length > 0) {
    const bag = await readSharedBag(params.runner.secretId);
    for (const declaration of shared) {
      const value = bag[declaration.key];
      if (typeof value === "string" && value.length > 0) {
        env[declaration.key] = value;
      } else if (declaration.required) {
        misconfigured.push(toMissing(declaration));
      }
    }
  }

  if (perUser.length > 0) {
    const resolved = await UserCredentialModel.resolveValues({
      organizationId: params.organizationId,
      userId: params.userId,
      keys: perUser.map((declaration) => declaration.key),
    });
    Object.assign(env, resolved.values);
    for (const declaration of perUser) {
      if (resolved.missing.includes(declaration.key) && declaration.required) {
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
export async function preflightRunnerCredentials(params: {
  runner: Pick<Runner, "id" | "credentials" | "secretId">;
  organizationId: string;
  userId: string;
}): Promise<{
  missing: MissingRunnerCredential[];
  misconfigured: MissingRunnerCredential[];
}> {
  const { shared, perUser } = splitDeclarations(params.runner.credentials);
  const missing: MissingRunnerCredential[] = [];
  const misconfigured: MissingRunnerCredential[] = [];

  const requiredShared = shared.filter((declaration) => declaration.required);
  if (requiredShared.length > 0) {
    const bag = await readSharedBag(params.runner.secretId);
    for (const declaration of requiredShared) {
      const value = bag[declaration.key];
      if (typeof value !== "string" || value.length === 0) {
        misconfigured.push(toMissing(declaration));
      }
    }
  }

  const requiredPerUser = perUser.filter((declaration) => declaration.required);
  if (requiredPerUser.length > 0) {
    const present = await UserCredentialModel.listPresentKeys({
      organizationId: params.organizationId,
      userId: params.userId,
      keys: requiredPerUser.map((declaration) => declaration.key),
    });
    for (const declaration of requiredPerUser) {
      if (!present.has(declaration.key)) {
        missing.push(toMissing(declaration));
      }
    }
  }

  return { missing, misconfigured };
}

// ===================== internals =====================

function splitDeclarations(
  declarations: RunnerCredentialDeclaration[] | null | undefined,
): {
  shared: RunnerCredentialDeclaration[];
  perUser: RunnerCredentialDeclaration[];
} {
  const shared: RunnerCredentialDeclaration[] = [];
  const perUser: RunnerCredentialDeclaration[] = [];
  for (const declaration of declarations ?? []) {
    if (declaration.scope === "per_user") {
      perUser.push(declaration);
    } else {
      shared.push(declaration);
    }
  }
  return { shared, perUser };
}

async function readSharedBag(
  secretId: string | null,
): Promise<Record<string, unknown>> {
  if (!secretId) {
    return {};
  }
  const secret = await secretManager().getSecret(secretId);
  if (!secret) {
    // The bag was deleted out from under the agent. Reported per-key as
    // misconfigured by the callers above rather than thrown here, so the
    // response can name every credential an administrator has to restore.
    logger.warn(
      { secretId },
      "Runner shared credential bag is missing from the secrets manager",
    );
    return {};
  }
  return secret.secret ?? {};
}

function toMissing(
  declaration: RunnerCredentialDeclaration,
): MissingRunnerCredential {
  return {
    key: declaration.key,
    label: declaration.label,
    description: declaration.description,
  };
}
