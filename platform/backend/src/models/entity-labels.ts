import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@/database";
import { createEntityLabelModel } from "./entity-label";
import { buildOrganizationLimitScopeCondition } from "./limit";

/**
 * Label models for every entity that carries labels but has no bespoke label
 * model of its own. Each entry is the junction table plus the rule for which
 * rows an organization is allowed to see, which is all
 * `createEntityLabelModel` needs.
 *
 * Agents, apps, MCP catalog entries and teams keep their own hand-written
 * models (`agent-label.ts` and friends) because callers already depend on
 * their entity-specific method names.
 */

export const SkillLabelModel = createEntityLabelModel({
  junction: {
    table: schema.skillLabelsTable,
    keyId: schema.skillLabelsTable.keyId,
    valueId: schema.skillLabelsTable.valueId,
  },
  ownerIdColumn: schema.skillLabelsTable.skillId,
  ownerIdKey: "skillId",
  owner: {
    table: schema.skillsTable,
    idColumn: schema.skillsTable.id,
    organizationScope: (organizationId) =>
      and(
        eq(schema.skillsTable.organizationId, organizationId),
        isNull(schema.skillsTable.deletedAt),
      ),
  },
});

export const KnowledgeBaseLabelModel = createEntityLabelModel({
  junction: {
    table: schema.knowledgeBaseLabelsTable,
    keyId: schema.knowledgeBaseLabelsTable.keyId,
    valueId: schema.knowledgeBaseLabelsTable.valueId,
  },
  ownerIdColumn: schema.knowledgeBaseLabelsTable.knowledgeBaseId,
  ownerIdKey: "knowledgeBaseId",
  owner: {
    table: schema.knowledgeBasesTable,
    idColumn: schema.knowledgeBasesTable.id,
    organizationScope: (organizationId) =>
      and(
        eq(schema.knowledgeBasesTable.organizationId, organizationId),
        isNull(schema.knowledgeBasesTable.deletedAt),
      ),
  },
});

export const KbFileLabelModel = createEntityLabelModel({
  junction: {
    table: schema.kbFileLabelsTable,
    keyId: schema.kbFileLabelsTable.keyId,
    valueId: schema.kbFileLabelsTable.valueId,
  },
  ownerIdColumn: schema.kbFileLabelsTable.fileId,
  ownerIdKey: "fileId",
  owner: {
    table: schema.kbFilesTable,
    idColumn: schema.kbFilesTable.id,
    organizationScope: (organizationId) =>
      eq(schema.kbFilesTable.organizationId, organizationId),
  },
});

export const KnowledgeBaseConnectorLabelModel = createEntityLabelModel({
  junction: {
    table: schema.knowledgeBaseConnectorLabelsTable,
    keyId: schema.knowledgeBaseConnectorLabelsTable.keyId,
    valueId: schema.knowledgeBaseConnectorLabelsTable.valueId,
  },
  ownerIdColumn: schema.knowledgeBaseConnectorLabelsTable.connectorId,
  ownerIdKey: "connectorId",
  owner: {
    table: schema.knowledgeBaseConnectorsTable,
    idColumn: schema.knowledgeBaseConnectorsTable.id,
    organizationScope: (organizationId) =>
      and(
        eq(schema.knowledgeBaseConnectorsTable.organizationId, organizationId),
        isNull(schema.knowledgeBaseConnectorsTable.deletedAt),
      ),
  },
});

export const LimitLabelModel = createEntityLabelModel({
  junction: {
    table: schema.limitLabelsTable,
    keyId: schema.limitLabelsTable.keyId,
    valueId: schema.limitLabelsTable.valueId,
  },
  ownerIdColumn: schema.limitLabelsTable.limitId,
  ownerIdKey: "limitId",
  owner: {
    table: schema.limitsTable,
    idColumn: schema.limitsTable.id,
    // `limits` has no organization column: a limit belongs to the organization
    // of the entity it targets, so scoping reuses the same predicate the limit
    // listing endpoint uses.
    organizationScope: (organizationId) =>
      buildOrganizationLimitScopeCondition(organizationId),
  },
});

export const ModelLabelModel = createEntityLabelModel({
  junction: {
    table: schema.modelLabelsTable,
    keyId: schema.modelLabelsTable.keyId,
    valueId: schema.modelLabelsTable.valueId,
  },
  ownerIdColumn: schema.modelLabelsTable.modelId,
  ownerIdKey: "modelId",
  owner: {
    table: schema.modelsTable,
    idColumn: schema.modelsTable.id,
    // The model catalog is deployment-wide (synced from models.dev, no
    // organization column), and only catalog admins can edit it. Its labels are
    // shared for the same reason its rows are, so the vocabulary is unscoped.
    organizationScope: () => undefined,
  },
});

export const LlmProviderApiKeyLabelModel = createEntityLabelModel({
  junction: {
    table: schema.llmProviderApiKeyLabelsTable,
    keyId: schema.llmProviderApiKeyLabelsTable.keyId,
    valueId: schema.llmProviderApiKeyLabelsTable.valueId,
  },
  ownerIdColumn: schema.llmProviderApiKeyLabelsTable.apiKeyId,
  ownerIdKey: "apiKeyId",
  owner: {
    table: schema.llmProviderApiKeysTable,
    idColumn: schema.llmProviderApiKeysTable.id,
    organizationScope: (organizationId) =>
      eq(schema.llmProviderApiKeysTable.organizationId, organizationId),
  },
});

export const VirtualApiKeyLabelModel = createEntityLabelModel({
  junction: {
    table: schema.virtualApiKeyLabelsTable,
    keyId: schema.virtualApiKeyLabelsTable.keyId,
    valueId: schema.virtualApiKeyLabelsTable.valueId,
  },
  ownerIdColumn: schema.virtualApiKeyLabelsTable.virtualApiKeyId,
  ownerIdKey: "virtualApiKeyId",
  owner: {
    table: schema.virtualApiKeysTable,
    idColumn: schema.virtualApiKeysTable.id,
    organizationScope: (organizationId) =>
      eq(schema.virtualApiKeysTable.organizationId, organizationId),
  },
});

export const PluginLabelModel = createEntityLabelModel({
  junction: {
    table: schema.pluginLabelsTable,
    keyId: schema.pluginLabelsTable.keyId,
    valueId: schema.pluginLabelsTable.valueId,
  },
  ownerIdColumn: schema.pluginLabelsTable.pluginId,
  ownerIdKey: "pluginId",
  owner: {
    table: schema.pluginsTable,
    idColumn: schema.pluginsTable.id,
    organizationScope: (organizationId) =>
      and(
        eq(schema.pluginsTable.organizationId, organizationId),
        isNull(schema.pluginsTable.deletedAt),
      ),
  },
});

export const ServiceAccountLabelModel = createEntityLabelModel({
  junction: {
    table: schema.serviceAccountLabelsTable,
    keyId: schema.serviceAccountLabelsTable.keyId,
    valueId: schema.serviceAccountLabelsTable.valueId,
  },
  ownerIdColumn: schema.serviceAccountLabelsTable.serviceAccountId,
  ownerIdKey: "serviceAccountId",
  owner: {
    table: schema.serviceAccountsTable,
    idColumn: schema.serviceAccountsTable.id,
    organizationScope: (organizationId) =>
      eq(schema.serviceAccountsTable.organizationId, organizationId),
  },
});

export const OauthClientLabelModel = createEntityLabelModel({
  junction: {
    table: schema.oauthClientLabelsTable,
    keyId: schema.oauthClientLabelsTable.keyId,
    valueId: schema.oauthClientLabelsTable.valueId,
  },
  ownerIdColumn: schema.oauthClientLabelsTable.clientId,
  ownerIdKey: "clientId",
  owner: {
    table: schema.oauthClientsTable,
    idColumn: schema.oauthClientsTable.id,
    // better-auth owns this table, so the organization lives in its JSON
    // metadata rather than a column — the same predicate the OAuth client
    // models use to scope their listings.
    organizationScope: (organizationId) =>
      sql`${schema.oauthClientsTable.metadata}->>'organizationId' = ${organizationId}`,
  },
});

export const EnvironmentLabelModel = createEntityLabelModel({
  junction: {
    table: schema.environmentLabelsTable,
    keyId: schema.environmentLabelsTable.keyId,
    valueId: schema.environmentLabelsTable.valueId,
  },
  ownerIdColumn: schema.environmentLabelsTable.environmentId,
  ownerIdKey: "environmentId",
  owner: {
    table: schema.environmentsTable,
    idColumn: schema.environmentsTable.id,
    organizationScope: (organizationId) =>
      eq(schema.environmentsTable.organizationId, organizationId),
  },
});
