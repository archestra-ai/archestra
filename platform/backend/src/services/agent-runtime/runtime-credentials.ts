import { isVaultReference } from "@archestra/shared";
import {
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { isByosEnabled } from "@/secrets-manager";
import type {
  InsertRuntimeCredentialDefinition,
  RuntimeCredentialConnectionScope,
  RuntimeCredentialDefinitionView,
  UpdateRuntimeCredentialDefinition,
} from "@/types";
import { ApiError } from "@/types";

export async function listRuntimeCredentialDefinitions(params: {
  organizationId: string;
  userId: string;
}): Promise<RuntimeCredentialDefinitionView[]> {
  const [custom, configured] = await Promise.all([
    RuntimeCredentialDefinitionModel.list(params.organizationId),
    RuntimeCredentialConnectionModel.listConfigured(params),
  ]);
  const personal = new Set(
    configured
      .filter(({ scope }) => scope === "personal")
      .map(({ credentialId }) => credentialId),
  );
  const organization = new Set(
    configured
      .filter(({ scope }) => scope === "organization")
      .map(({ credentialId }) => credentialId),
  );
  return [
    ...custom.map((definition) => ({
      key: definition.key,
      name: definition.name,
      description: definition.description,
      icon: definition.icon,
      builtIn: false,
      allowPersonal: definition.allowPersonal,
      allowOrganization: definition.allowOrganization,
    })),
  ]
    .map((definition) => ({
      ...definition,
      personalConfigured: personal.has(definition.key),
      organizationConfigured: organization.has(definition.key),
    }))
    .sort(
      (left, right) =>
        Number(right.builtIn) - Number(left.builtIn) ||
        left.name.localeCompare(right.name),
    );
}

export async function createRuntimeCredentialDefinition(params: {
  organizationId: string;
  userId: string;
  definition: InsertRuntimeCredentialDefinition;
}) {
  if (params.definition.key === "claude-code") {
    throw new ApiError(
      400,
      "Claude Code accounts connect through native sign-in on the Agent.",
    );
  }
  assertExactlyOneScopeAllowed({
    allowPersonal: params.definition.allowPersonal ?? true,
    allowOrganization: params.definition.allowOrganization ?? false,
  });
  if (
    await findRuntimeCredentialDefinition({
      organizationId: params.organizationId,
      key: params.definition.key,
    })
  ) {
    throw new ApiError(409, "A credential with this name already exists");
  }
  return RuntimeCredentialDefinitionModel.create({
    organizationId: params.organizationId,
    createdBy: params.userId,
    definition: params.definition,
  });
}

export async function getRuntimeCredentialUsage(params: {
  organizationId: string;
  key: string;
}) {
  await requireRuntimeCredentialDefinition({
    organizationId: params.organizationId,
    credentialId: params.key,
  });
  return {
    agents: await RuntimeCredentialDefinitionModel.listAgentsUsing(params),
  };
}

export async function updateRuntimeCredentialDefinition(params: {
  organizationId: string;
  key: string;
  definition: UpdateRuntimeCredentialDefinition;
}) {
  const current = await RuntimeCredentialDefinitionModel.find(params);
  if (!current) throw new ApiError(404, "Credential not found");
  const updated = await RuntimeCredentialDefinitionModel.update(params);
  if (!updated) throw new ApiError(404, "Credential not found");
  return updated;
}

export async function deleteRuntimeCredentialDefinition(params: {
  organizationId: string;
  key: string;
}) {
  if (await RuntimeCredentialDefinitionModel.isUsedByAgent(params)) {
    throw new ApiError(
      409,
      "Remove this credential from Agent bindings before deleting it",
    );
  }
  const deleted = await RuntimeCredentialDefinitionModel.delete(params);
  if (!deleted) throw new ApiError(404, "Credential not found");
  await RuntimeCredentialConnectionModel.deleteForDefinition({
    organizationId: params.organizationId,
    credentialId: params.key,
  });
  return deleted;
}

export async function setRuntimeCredentialConnection(params: {
  organizationId: string;
  userId: string;
  credentialId: string;
  scope: RuntimeCredentialConnectionScope;
  value: string;
}) {
  assertConnectionValue(params.value);
  const definition = await requireRuntimeCredentialDefinition(params);
  assertScopeAllowed({ definition, scope: params.scope });
  return RuntimeCredentialConnectionModel.upsert({
    organizationId: params.organizationId,
    userId: params.scope === "personal" ? params.userId : null,
    credentialId: params.credentialId,
    scope: params.scope,
    value: params.value,
  });
}

export async function deleteRuntimeCredentialConnection(params: {
  organizationId: string;
  userId: string;
  credentialId: string;
  scope: RuntimeCredentialConnectionScope;
}): Promise<boolean> {
  await requireRuntimeCredentialDefinition(params);
  return RuntimeCredentialConnectionModel.delete({
    organizationId: params.organizationId,
    userId: params.scope === "personal" ? params.userId : null,
    credentialId: params.credentialId,
    scope: params.scope,
  });
}

export async function getRuntimeCredentialConnectionAuditSnapshot(params: {
  organizationId: string;
  credentialId: string;
  scope: RuntimeCredentialConnectionScope;
}): Promise<Record<string, unknown> | null> {
  return RuntimeCredentialConnectionModel.findForAudit({
    ...params,
    userId: null,
  });
}

async function requireRuntimeCredentialDefinition(params: {
  organizationId: string;
  credentialId: string;
}): Promise<Definition> {
  const definition = await findRuntimeCredentialDefinition({
    organizationId: params.organizationId,
    key: params.credentialId,
  });
  if (!definition) {
    throw new ApiError(
      400,
      `Credential connection “${params.credentialId}” is not available`,
    );
  }
  return definition;
}

// ===================== Internals =====================

type Definition = {
  key: string;
  name: string;
  description: string;
  icon: string | null;
  builtIn: boolean;
  allowPersonal: boolean;
  allowOrganization: boolean;
};

async function findRuntimeCredentialDefinition(params: {
  organizationId: string;
  key: string;
}): Promise<Definition | null> {
  const custom = await RuntimeCredentialDefinitionModel.find(params);
  return custom ? { ...custom, builtIn: false } : null;
}

function assertExactlyOneScopeAllowed(definition: {
  allowPersonal: boolean;
  allowOrganization: boolean;
}): void {
  if (definition.allowPersonal === definition.allowOrganization) {
    throw new ApiError(
      400,
      "Choose either personal connections or organization connections",
    );
  }
}

function assertScopeAllowed(params: {
  definition: Definition;
  scope: RuntimeCredentialConnectionScope;
}): void {
  const allowed =
    params.scope === "personal"
      ? params.definition.allowPersonal
      : params.definition.allowOrganization;
  if (!allowed) {
    throw new ApiError(
      400,
      `${params.definition.name} does not allow ${params.scope} connections`,
    );
  }
}

function assertConnectionValue(value: string): void {
  if (!isByosEnabled()) return;
  if (!isVaultReference(value)) {
    throw new ApiError(
      400,
      "Readonly Vault credentials must select a secret and key",
    );
  }
}
