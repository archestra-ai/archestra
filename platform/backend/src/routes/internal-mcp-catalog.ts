import { isBuiltInCatalogId, isPlaywrightCatalogItem, RouteId } from "@shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import config from "@/config";
import {
  generateDeploymentYamlTemplate,
  mergeLocalConfigIntoYaml,
  validateDeploymentYaml,
} from "@/k8s/mcp-server-runtime/k8s-yaml-generator";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import logger from "@/logging";
import {
  InternalMcpCatalogModel,
  McpCatalogLabelModel,
  McpPresetEntryModel,
  McpServerModel,
  TeamModel,
  ToolModel,
} from "@/models";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import {
  autoReinstallServer,
  requiresNewUserInputForReinstall,
} from "@/services/mcp-reinstall";
import {
  ApiError,
  CreateChildCatalogSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY,
  InsertInternalMcpCatalogSchema,
  type InternalMcpCatalog,
  ListInternalMcpCatalogSchema,
  PartialUpdateInternalMcpCatalogSchema,
  type PresetFieldValues,
  SelectInternalMcpCatalogSchema,
  UpdateChildCatalogSchema,
  UuidIdSchema,
} from "@/types";
import { broadcastMcpInstallationStatus } from "@/websocket";

/**
 * Columns propagated from a parent catalog item to its children — both at
 * child creation and on parent-edit cascade. Children inherit the parent's
 * template and overlay only their `presetFieldValues` / identity columns.
 *
 * Note: `multitenant` is included so newly-created children match the parent.
 * On parent PUT cascade, the schema-level "locked after creation" rule on
 * Update silently no-ops it, which is what we want — children's tenancy was
 * fixed at creation time.
 */
type SyncableCatalogFields = Pick<
  InternalMcpCatalog,
  | "version"
  | "description"
  | "instructions"
  | "repository"
  | "installationCommand"
  | "requiresAuth"
  | "authDescription"
  | "authFields"
  | "serverType"
  | "multitenant"
  | "serverUrl"
  | "docsUrl"
  | "clientSecretId"
  | "localConfigSecretId"
  | "localConfig"
  | "deploymentSpecYaml"
  | "userConfig"
  | "oauthConfig"
  | "enterpriseManagedConfig"
  | "icon"
>;

// Match the schema from getMcpServerTools endpoint
const ToolWithAssignedAgentCountSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  parameters: z.record(z.string(), z.any()),
  createdAt: z.coerce.date(),
  assignedAgentCount: z.number(),
  assignedAgents: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
});

const internalMcpCatalogRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/internal_mcp_catalog",
    {
      schema: {
        operationId: RouteId.GetInternalMcpCatalog,
        description: "Get all Internal MCP catalog items",
        tags: ["MCP Catalog"],
        querystring: z.object({
          includeChildren: z
            .union([z.boolean(), z.enum(["true", "false"])])
            .optional()
            .transform((v) => v === true || v === "true"),
        }),
        response: constructResponseSchema(
          z.array(ListInternalMcpCatalogSchema),
        ),
      },
    },
    async (request, reply) => {
      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      // Don't expand secrets for list view
      return reply.send(
        await InternalMcpCatalogModel.findAll({
          expandSecrets: false,
          userId: request.user.id,
          isAdmin,
          organizationId: request.organizationId,
          includeChildren: request.query.includeChildren,
        }),
      );
    },
  );

  fastify.post(
    "/api/internal_mcp_catalog",
    {
      schema: {
        operationId: RouteId.CreateInternalMcpCatalogItem,
        description: "Create a new Internal MCP catalog item",
        tags: ["MCP Catalog"],
        body: InsertInternalMcpCatalogSchema.extend({
          // BYOS: External Vault path for OAuth client secret
          oauthClientSecretVaultPath: z.string().optional(),
          // BYOS: External Vault key for OAuth client secret
          oauthClientSecretVaultKey: z.string().optional(),
          // BYOS: External Vault path for local config secret env vars
          localConfigVaultPath: z.string().optional(),
          // BYOS: External Vault key for local config secret env vars
          localConfigVaultKey: z.string().optional(),
        }),
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
      },
    },
    async (request, reply) => {
      const { body } = request;
      const {
        oauthClientSecretVaultPath,
        oauthClientSecretVaultKey,
        localConfigVaultPath,
        localConfigVaultKey,
        ...restBodyInput
      } = body;
      // Downstream secret extraction removes plaintext values from the payload
      // before persistence, so work on a cloned object instead of the request body.
      const restBody = structuredClone(restBodyInput);

      // Enforce scope restrictions
      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );

      restBody.scope = restBody.scope ?? "personal";
      if (!isAdmin && restBody.scope === "org") {
        throw new ApiError(
          403,
          "Only admins can create org-scoped catalog items",
        );
      }
      if (restBody.scope !== "team") {
        delete restBody.teams;
      }

      let clientSecretId: string | undefined;
      let localConfigSecretId: string | undefined;

      // Handle OAuth client secret - either via BYOS or direct value
      if (oauthClientSecretVaultPath && oauthClientSecretVaultKey) {
        // BYOS flow for OAuth client secret
        if (!isByosEnabled()) {
          throw new ApiError(
            400,
            "Readonly Vault is not enabled. " +
              "Requires ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT and an enterprise license.",
          );
        }

        // Store as { client_secret: "path#key" } format
        const vaultReference = `${oauthClientSecretVaultPath}#${oauthClientSecretVaultKey}`;
        const secret = await secretManager().createSecret(
          { client_secret: vaultReference },
          `${restBody.name}-oauth-client-secret-vault`,
        );
        clientSecretId = secret.id;
        restBody.clientSecretId = clientSecretId;

        // Remove client_secret from oauthConfig if present
        if (restBody.oauthConfig && "client_secret" in restBody.oauthConfig) {
          delete restBody.oauthConfig.client_secret;
        }

        logger.info(
          "Created Readonly Vault external vault secret reference for OAuth client secret",
        );
      } else if (
        restBody.oauthConfig &&
        "client_secret" in restBody.oauthConfig
      ) {
        // Direct client_secret value
        const clientSecret = restBody.oauthConfig.client_secret;
        if (clientSecret) {
          clientSecretId = await upsertCatalogClientSecretValue({
            clientSecretId,
            catalogName: restBody.name,
            key: "client_secret",
            value: clientSecret,
          });

          restBody.clientSecretId = clientSecretId;
        }
        delete restBody.oauthConfig.client_secret;
      }

      const enterpriseManagedClientSecretOverride =
        restBody.enterpriseManagedConfig?.clientSecretOverride;
      if (enterpriseManagedClientSecretOverride) {
        clientSecretId = await upsertCatalogClientSecretValue({
          clientSecretId,
          catalogName: restBody.name,
          key: ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY,
          value: enterpriseManagedClientSecretOverride,
        });

        restBody.clientSecretId = clientSecretId;
        delete restBody.enterpriseManagedConfig?.clientSecretOverride;
      }

      // Handle local config secrets - either via Readonly Vault or direct values
      if (localConfigVaultPath && localConfigVaultKey) {
        // Readonly Vault flow for local config secrets
        if (!isByosEnabled()) {
          throw new ApiError(
            400,
            "Readonly Vault is not enabled. " +
              "Requires ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT and an enterprise license.",
          );
        }

        // Store as { vaultKey: "path#vaultKey" } format
        // The vault key becomes both the Archestra key and references itself in the vault
        const vaultReference = `${localConfigVaultPath}#${localConfigVaultKey}`;
        const secret = await secretManager().createSecret(
          { [localConfigVaultKey]: vaultReference },
          `${restBody.name}-local-config-env-vault`,
        );
        localConfigSecretId = secret.id;
        restBody.localConfigSecretId = localConfigSecretId;

        // Remove values from secret env vars in catalog template
        if (restBody.localConfig?.environment) {
          for (const envVar of restBody.localConfig.environment) {
            if (envVar.type === "secret" && !envVar.promptOnInstallation) {
              delete envVar.value;
            }
          }
        }

        logger.info(
          "Created Readonly Vault external vault secret reference for local config secrets",
        );
      } else if (
        restBody.localConfig?.environment ||
        restBody.localConfig?.imagePullSecrets ||
        restBody.userConfig
      ) {
        const localConfig = restBody.localConfig;
        // Extract secret env vars from localConfig.environment
        const secretEnvVars: Record<string, string> = {};
        if (localConfig?.environment) {
          for (const envVar of localConfig.environment) {
            if (
              envVar.type === "secret" &&
              envVar.value &&
              !envVar.promptOnInstallation
            ) {
              secretEnvVars[envVar.key] = envVar.value;
              delete envVar.value; // Remove value from catalog template
            }
          }
        }

        // Extract image pull secret passwords from credentials entries
        // Keyed by server:username (stable across reorder, unique per account)
        if (localConfig?.imagePullSecrets) {
          for (const entry of localConfig.imagePullSecrets) {
            if (entry.source === "credentials" && entry.password) {
              secretEnvVars[
                `__regcred_password:${entry.server}:${entry.username}`
              ] = entry.password;
              delete entry.password; // Strip from catalog template
            }
          }
        }

        // Store secret env vars if any exist
        if (Object.keys(secretEnvVars).length > 0) {
          const secret = await secretManager().createSecret(
            secretEnvVars,
            `${restBody.name}-local-config-env`,
          );
          localConfigSecretId = secret.id;
          restBody.localConfigSecretId = localConfigSecretId;
        }
      }

      // Only merge environment variables into YAML if YAML is explicitly provided
      // The YAML is only stored when explicitly edited via the "Edit Deployment Yaml" dialog
      if (restBody.deploymentSpecYaml && restBody.localConfig?.environment) {
        restBody.deploymentSpecYaml = mergeLocalConfigIntoYaml(
          restBody.deploymentSpecYaml,
          restBody.localConfig.environment,
        );
      }

      const catalogItem = await InternalMcpCatalogModel.create(restBody, {
        organizationId: request.organizationId,
        authorId: request.user.id,
      });
      return reply.send(catalogItem);
    },
  );

  fastify.get(
    "/api/internal_mcp_catalog/:id",
    {
      schema: {
        operationId: RouteId.GetInternalMcpCatalogItem,
        description: "Get Internal MCP catalog item by ID",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      const catalogItem = await InternalMcpCatalogModel.findById(id, {
        userId: request.user.id,
        isAdmin,
        organizationId: request.organizationId,
      });

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      return reply.send(catalogItem);
    },
  );

  fastify.get(
    "/api/internal_mcp_catalog/:id/tools",
    {
      schema: {
        operationId: RouteId.GetInternalMcpCatalogTools,
        description:
          "Get tools for a catalog item (including builtin Archestra tools)",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.array(ToolWithAssignedAgentCountSchema),
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      // The built-in Archestra catalog is virtual; custom/private catalog IDs
      // still need an access-checked backing row.
      if (!isBuiltInCatalogId(id)) {
        const catalogItem = await InternalMcpCatalogModel.findById(id, {
          userId: request.user.id,
          isAdmin,
          organizationId: request.organizationId,
        });

        if (!catalogItem) {
          throw new ApiError(404, "Catalog item not found");
        }
      }

      const tools = await ToolModel.findByCatalogId(id);
      return reply.send(tools);
    },
  );

  fastify.put(
    "/api/internal_mcp_catalog/:id",
    {
      schema: {
        operationId: RouteId.UpdateInternalMcpCatalogItem,
        description: "Update an Internal MCP catalog item",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        body: PartialUpdateInternalMcpCatalogSchema.extend({
          // BYOS: External Vault path for OAuth client secret
          oauthClientSecretVaultPath: z.string().optional(),
          // BYOS: External Vault key for OAuth client secret
          oauthClientSecretVaultKey: z.string().optional(),
          // BYOS: External Vault path for local config secret env vars
          localConfigVaultPath: z.string().optional(),
          // BYOS: External Vault key for local config secret env vars
          localConfigVaultKey: z.string().optional(),
        }),
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { body } = request;
      if (isBuiltInCatalogId(id) && !isPlaywrightCatalogItem(id)) {
        throw new ApiError(403, "Built-in catalog items cannot be modified");
      }

      // Prevent renaming the Playwright catalog item
      if (isPlaywrightCatalogItem(id) && body.name !== undefined) {
        delete body.name;
      }

      const {
        oauthClientSecretVaultPath,
        oauthClientSecretVaultKey,
        localConfigVaultPath,
        localConfigVaultKey,
        ...restBodyInput
      } = body;
      // Downstream secret extraction removes plaintext values from the payload
      // before persistence, so work on a cloned object instead of the request body.
      const restBody = structuredClone(restBodyInput);

      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );

      // Get the original catalog item to check if name or serverUrl changed
      const originalCatalogItem = await InternalMcpCatalogModel.findById(id, {
        userId: request.user.id,
        isAdmin,
        organizationId: request.organizationId,
      });

      if (!originalCatalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      if (!isAdmin) {
        // Non-admins can only edit their own personal items
        if (
          originalCatalogItem.scope !== "personal" ||
          originalCatalogItem.authorId !== request.user.id
        ) {
          throw new ApiError(
            403,
            "You can only edit your own personal catalog items",
          );
        }
        // Non-admins cannot set scope to "org"
        if (restBody.scope === "org") {
          throw new ApiError(
            403,
            "Only admins can set catalog items to org scope",
          );
        }
      }

      if (restBody.scope && restBody.scope !== "team") {
        delete restBody.teams;
      }

      let clientSecretId = originalCatalogItem.clientSecretId;
      let localConfigSecretId = originalCatalogItem.localConfigSecretId;

      // Handle OAuth client secret - either via Readonly Vault or direct value
      if (oauthClientSecretVaultPath && oauthClientSecretVaultKey) {
        // Readonly Vault flow for OAuth client secret
        if (!isByosEnabled()) {
          throw new ApiError(
            400,
            "Readonly Vault is not enabled. " +
              "Requires ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT and an enterprise license.",
          );
        }

        const existingSecretValues =
          await getCatalogClientSecretValues(clientSecretId);

        // Delete existing secret if any
        if (clientSecretId) {
          await secretManager().deleteSecret(clientSecretId);
        }

        // Store as { client_secret: "path#key" } format
        const vaultReference = `${oauthClientSecretVaultPath}#${oauthClientSecretVaultKey}`;
        const secret = await secretManager().createSecret(
          { ...existingSecretValues, client_secret: vaultReference },
          `${originalCatalogItem.name}-oauth-client-secret-vault`,
        );
        clientSecretId = secret.id;
        restBody.clientSecretId = clientSecretId;

        // Remove client_secret from oauthConfig if present
        if (restBody.oauthConfig && "client_secret" in restBody.oauthConfig) {
          delete restBody.oauthConfig.client_secret;
        }

        logger.info(
          "Created Readonly Vault external vault secret reference for OAuth client secret",
        );
      } else if (
        restBody.oauthConfig &&
        "client_secret" in restBody.oauthConfig
      ) {
        // Direct client_secret value
        const clientSecret = restBody.oauthConfig.client_secret;
        if (clientSecret) {
          clientSecretId = await upsertCatalogClientSecretValue({
            clientSecretId,
            catalogName: originalCatalogItem.name,
            key: "client_secret",
            value: clientSecret,
          });

          restBody.clientSecretId = clientSecretId;
        }
        delete restBody.oauthConfig.client_secret;
      }

      const enterpriseManagedClientSecretOverride =
        restBody.enterpriseManagedConfig?.clientSecretOverride;
      if (enterpriseManagedClientSecretOverride) {
        clientSecretId = await upsertCatalogClientSecretValue({
          clientSecretId,
          catalogName: originalCatalogItem.name,
          key: ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY,
          value: enterpriseManagedClientSecretOverride,
        });

        restBody.clientSecretId = clientSecretId;
        delete restBody.enterpriseManagedConfig?.clientSecretOverride;
      }

      // Handle local config secrets - either via Readonly Vault or direct values
      if (localConfigVaultPath && localConfigVaultKey) {
        // Readonly Vault flow for local config secrets
        if (!isByosEnabled()) {
          throw new ApiError(
            400,
            "Readonly Vault is not enabled. " +
              "Requires ARCHESTRA_SECRETS_MANAGER=READONLY_VAULT and an enterprise license.",
          );
        }

        // Delete existing secret if any
        if (localConfigSecretId) {
          await secretManager().deleteSecret(localConfigSecretId);
        }

        // Store as { vaultKey: "path#vaultKey" } format
        const vaultReference = `${localConfigVaultPath}#${localConfigVaultKey}`;
        const secret = await secretManager().createSecret(
          { [localConfigVaultKey]: vaultReference },
          `${originalCatalogItem.name}-local-config-env-vault`,
        );
        localConfigSecretId = secret.id;
        restBody.localConfigSecretId = localConfigSecretId;

        // Remove values from secret env vars in catalog template
        if (restBody.localConfig?.environment) {
          for (const envVar of restBody.localConfig.environment) {
            if (envVar.type === "secret" && !envVar.promptOnInstallation) {
              delete envVar.value;
            }
          }
        }

        logger.info(
          "Created Readonly Vault external vault secret reference for local config secrets",
        );
      } else if (
        restBody.localConfig?.environment ||
        restBody.localConfig?.imagePullSecrets ||
        restBody.userConfig
      ) {
        const localConfig = restBody.localConfig;
        // Get existing secret values to preserve keys that are still in the request
        const existingSecretValues: Record<string, string> = {};
        if (localConfigSecretId) {
          const existingSecret =
            await secretManager().getSecret(localConfigSecretId);
          if (existingSecret?.secret) {
            for (const [key, value] of Object.entries(existingSecret.secret)) {
              existingSecretValues[key] = String(value);
            }
          }
        }

        // Extract secret env vars from localConfig.environment
        // Preserve existing values for keys that are in the request but have no new value
        const secretEnvVars: Record<string, string> = {};

        for (const envVar of localConfig?.environment ?? []) {
          if (envVar.type === "secret" && !envVar.promptOnInstallation) {
            if (envVar.value) {
              // New value provided - use it
              secretEnvVars[envVar.key] = envVar.value;
              delete envVar.value; // Remove value from catalog template
            } else if (existingSecretValues[envVar.key]) {
              // No new value but key exists in existing secret - preserve it
              secretEnvVars[envVar.key] = existingSecretValues[envVar.key];
            }
            // If no value and not in existing secret, skip (user added key without value)
          }
        }

        // Extract image pull secret passwords from credentials entries
        // Keyed by server:username (stable across reorder, unique per account)
        // Preserve existing passwords for entries that don't provide a new one
        if (localConfig?.imagePullSecrets) {
          for (const entry of localConfig.imagePullSecrets) {
            if (entry.source === "credentials") {
              const regcredKey = `__regcred_password:${entry.server}:${entry.username}`;
              if (entry.password) {
                // New password provided - use it
                secretEnvVars[regcredKey] = entry.password;
                delete entry.password; // Strip from catalog template
              } else if (existingSecretValues[regcredKey]) {
                // No new password but key exists in existing secret - preserve it
                secretEnvVars[regcredKey] = existingSecretValues[regcredKey];
              }
            }
          }
        }
        // Orphaned __regcred_password:* keys (from removed entries) are implicitly
        // dropped since they won't be in secretEnvVars when the secret is updated

        // Store secret env vars if any exist
        if (Object.keys(secretEnvVars).length > 0) {
          if (localConfigSecretId) {
            // Update existing secret
            await secretManager().updateSecret(
              localConfigSecretId,
              secretEnvVars,
            );
          } else {
            // Create new secret
            const secret = await secretManager().createSecret(
              secretEnvVars,
              `${originalCatalogItem.name}-local-config-env`,
            );
            localConfigSecretId = secret.id;
          }
          restBody.localConfigSecretId = localConfigSecretId;
        }
      }

      // Merge environment variables into YAML in two cases:
      // 1. YAML is explicitly provided in request (user editing via "Edit Deployment Yaml" dialog)
      // 2. YAML already exists in database and env vars are being updated (main form edit)
      const yamlToUpdate =
        restBody.deploymentSpecYaml ?? originalCatalogItem.deploymentSpecYaml;

      if (yamlToUpdate && restBody.localConfig?.environment) {
        const environment = restBody.localConfig.environment;

        // Build set of previously managed keys to detect removed env vars
        const previouslyManagedKeys = new Set<string>(
          (originalCatalogItem.localConfig?.environment ?? []).map(
            (env) => env.key,
          ),
        );

        // Merge current environment into the YAML
        restBody.deploymentSpecYaml = mergeLocalConfigIntoYaml(
          yamlToUpdate,
          environment,
          previouslyManagedKeys,
        );
      }

      // Children are edited via PATCH /:parentId/children/:childId — the
      // catalog template fields cascade from parent only.
      if (originalCatalogItem.parentCatalogItemId !== null) {
        throw new ApiError(
          400,
          "Child catalog items (presets) cannot be edited via this endpoint. " +
            "Use PATCH /api/internal_mcp_catalog/:parentId/children/:childId.",
        );
      }

      // Default-preset values land on the parent row. Route them through the
      // secret partitioner so secret-flagged keys end up in a secret bundle
      // rather than the plaintext preset_field_values jsonb.
      if (restBody.presetFieldValues !== undefined) {
        const { nonSecretFieldValues, presetSecretId } =
          await partitionPresetFieldValuesAndUpsertSecrets({
            parent: originalCatalogItem,
            catalogRow: {
              name: restBody.name ?? originalCatalogItem.name,
              presetSecretId: originalCatalogItem.presetSecretId,
            },
            incoming: restBody.presetFieldValues,
          });
        restBody.presetFieldValues = nonSecretFieldValues;
        if (presetSecretId !== originalCatalogItem.presetSecretId) {
          (restBody as Record<string, unknown>).presetSecretId = presetSecretId;
        }
      }

      // Update the catalog item
      const catalogItem = await InternalMcpCatalogModel.update(id, restBody);

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      // Cascade reinstall for the parent's own installs.
      await cascadeReinstallForCatalog(originalCatalogItem, catalogItem);

      // Cascade syncable fields to children, then trigger reinstall for each
      // child's installs. Note: this snapshots children BEFORE updating them
      // so the original-vs-new comparison passed to the cascade helper still
      // reflects what changed.
      const children = await InternalMcpCatalogModel.findChildren(id);
      const syncableValues = pickSyncableFields(catalogItem);
      for (const originalChild of children) {
        const updatedChild = await InternalMcpCatalogModel.update(
          originalChild.id,
          syncableValues,
        );
        if (!updatedChild) continue;
        await cascadeReinstallForCatalog(originalChild, updatedChild);
      }

      // Note: Tools are NOT deleted - they are synced during reinstall to preserve
      // policies and profile assignments

      return reply.send(catalogItem);
    },
  );

  fastify.delete(
    "/api/internal_mcp_catalog/:id",
    {
      schema: {
        operationId: RouteId.DeleteInternalMcpCatalogItem,
        description: "Delete an Internal MCP catalog item",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (isBuiltInCatalogId(id)) {
        throw new ApiError(403, "Built-in catalog items cannot be deleted");
      }

      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );

      // Get the catalog item to check if it has secrets - don't expand secrets, just need IDs
      const catalogItem = await InternalMcpCatalogModel.findById(id, {
        userId: request.user.id,
        isAdmin,
        organizationId: request.organizationId,
        expandSecrets: false,
      });

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      // Enforce ownership: non-admins can only delete own personal items
      if (
        !isAdmin &&
        (catalogItem.scope !== "personal" ||
          catalogItem.authorId !== request.user.id)
      ) {
        throw new ApiError(
          403,
          "You can only delete your own personal catalog items",
        );
      }

      await deleteCatalogSecretsCascade(catalogItem);

      return reply.send({
        success: await InternalMcpCatalogModel.delete(id),
      });
    },
  );

  fastify.delete(
    "/api/internal_mcp_catalog/by-name/:name",
    {
      schema: {
        operationId: RouteId.DeleteInternalMcpCatalogItemByName,
        description: "Delete an Internal MCP catalog item by name",
        tags: ["MCP Catalog"],
        params: z.object({
          name: z.string().min(1),
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      const { name } = request.params;
      const catalogItem = await InternalMcpCatalogModel.findByName(name, {
        organizationId: request.organizationId,
      });

      if (!catalogItem) {
        throw new ApiError(404, `Catalog item with name "${name}" not found`);
      }

      if (isBuiltInCatalogId(catalogItem.id)) {
        throw new ApiError(403, "Built-in catalog items cannot be deleted");
      }

      // Enforce ownership: non-admins can only delete own personal items
      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      if (
        !isAdmin &&
        (catalogItem.scope !== "personal" ||
          catalogItem.authorId !== request.user.id)
      ) {
        throw new ApiError(
          403,
          "You can only delete your own personal catalog items",
        );
      }

      await deleteCatalogSecretsCascade(catalogItem);

      return reply.send({
        success: await InternalMcpCatalogModel.delete(catalogItem.id),
      });
    },
  );

  // Schema for deployment YAML preview response
  const DeploymentYamlPreviewSchema = z.object({
    yaml: z.string(),
  });

  // Schema for deployment YAML validation response
  const DeploymentYamlValidationSchema = z.object({
    valid: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
  });

  fastify.get(
    "/api/internal_mcp_catalog/:id/deployment-yaml-preview",
    {
      schema: {
        operationId: RouteId.GetDeploymentYamlPreview,
        description:
          "Generate a deployment YAML template preview for a catalog item",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeploymentYamlPreviewSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      const catalogItem = await InternalMcpCatalogModel.findById(id, {
        userId: request.user.id,
        isAdmin,
        organizationId: request.organizationId,
      });

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      if (catalogItem.serverType !== "local") {
        throw new ApiError(
          400,
          "Deployment YAML preview is only available for local MCP servers",
        );
      }

      // If the catalog item already has a deploymentSpecYaml, return it
      if (catalogItem.deploymentSpecYaml) {
        return reply.send({
          yaml: catalogItem.deploymentSpecYaml,
        });
      }

      // Extract imagePullSecrets names for YAML preview (existing names only,
      // credentials entries use generated names at deploy time)
      const imagePullSecretsForYaml = catalogItem.localConfig?.imagePullSecrets
        ?.filter((s) => s.source === "existing")
        .map((s) => ({ name: s.name }));

      // Generate a default YAML template
      const yamlTemplate = generateDeploymentYamlTemplate({
        serverId: "{server_id}",
        serverName: catalogItem.name,
        namespace: config.orchestrator.kubernetes.namespace,
        dockerImage:
          catalogItem.localConfig?.dockerImage ||
          config.orchestrator.mcpServerBaseImage,
        command: catalogItem.localConfig?.command,
        arguments: catalogItem.localConfig?.arguments,
        environment: catalogItem.localConfig?.environment,
        serviceAccount: catalogItem.localConfig?.serviceAccount,
        transportType: catalogItem.localConfig?.transportType,
        httpPort: catalogItem.localConfig?.httpPort,
        imagePullSecrets: imagePullSecretsForYaml,
      });

      return reply.send({ yaml: yamlTemplate });
    },
  );

  fastify.post(
    "/api/internal_mcp_catalog/validate-deployment-yaml",
    {
      schema: {
        operationId: RouteId.ValidateDeploymentYaml,
        description: "Validate a deployment YAML template",
        tags: ["MCP Catalog"],
        body: z.object({
          yaml: z.string().min(1, "YAML content is required"),
        }),
        response: constructResponseSchema(DeploymentYamlValidationSchema),
      },
    },
    async ({ body: { yaml } }, reply) => {
      const result = validateDeploymentYaml(yaml);
      return reply.send(result);
    },
  );

  fastify.post(
    "/api/internal_mcp_catalog/:id/reset-deployment-yaml",
    {
      schema: {
        operationId: RouteId.ResetDeploymentYaml,
        description:
          "Reset the deployment YAML to default by clearing the custom YAML",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeploymentYamlPreviewSchema),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      const catalogItem = await InternalMcpCatalogModel.findById(id, {
        userId: request.user.id,
        isAdmin,
        organizationId: request.organizationId,
      });

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      if (catalogItem.serverType !== "local") {
        throw new ApiError(
          400,
          "Deployment YAML reset is only available for local MCP servers",
        );
      }

      // Clear the custom deployment YAML
      await InternalMcpCatalogModel.update(id, { deploymentSpecYaml: null });

      // Extract imagePullSecrets names for YAML preview
      const imagePullSecretsForYaml = catalogItem.localConfig?.imagePullSecrets
        ?.filter((s) => s.source === "existing")
        .map((s) => ({ name: s.name }));

      // Generate and return a fresh default YAML template
      const yamlTemplate = generateDeploymentYamlTemplate({
        serverId: "{server_id}",
        serverName: catalogItem.name,
        namespace: config.orchestrator.kubernetes.namespace,
        dockerImage:
          catalogItem.localConfig?.dockerImage ||
          config.orchestrator.mcpServerBaseImage,
        command: catalogItem.localConfig?.command,
        arguments: catalogItem.localConfig?.arguments,
        environment: catalogItem.localConfig?.environment,
        serviceAccount: catalogItem.localConfig?.serviceAccount,
        transportType: catalogItem.localConfig?.transportType,
        httpPort: catalogItem.localConfig?.httpPort,
        imagePullSecrets: imagePullSecretsForYaml,
      });

      return reply.send({ yaml: yamlTemplate });
    },
  );

  fastify.get(
    "/api/k8s/image-pull-secrets",
    {
      schema: {
        operationId: RouteId.GetK8sImagePullSecrets,
        description:
          "List Kubernetes docker-registry secrets available for imagePullSecrets",
        tags: ["MCP Catalog"],
        response: constructResponseSchema(
          z.array(z.object({ name: z.string() })),
        ),
      },
    },
    async ({ user, headers }, reply) => {
      const { success: isMcpServerAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        headers,
      );

      const secrets = isMcpServerAdmin
        ? await mcpServerRuntimeManager.listDockerRegistrySecrets({
            isAdmin: true,
          })
        : await mcpServerRuntimeManager.listDockerRegistrySecrets({
            teamIds: await TeamModel.getUserTeamIds(user.id),
          });

      return reply.send(secrets);
    },
  );

  fastify.get(
    "/api/internal_mcp_catalog/labels/keys",
    {
      schema: {
        operationId: RouteId.GetInternalMcpCatalogLabelKeys,
        description: "Get all label keys used by catalog items",
        tags: ["MCP Catalog"],
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async (_request, reply) => {
      return reply.send(await McpCatalogLabelModel.getAllKeys());
    },
  );

  fastify.get(
    "/api/internal_mcp_catalog/:catalogId/children",
    {
      schema: {
        operationId: RouteId.GetCatalogChildren,
        description:
          'List child catalog items ("presets" in UI) for a parent catalog item',
        tags: ["MCP Catalog"],
        params: z.object({
          catalogId: UuidIdSchema,
        }),
        response: constructResponseSchema(
          z.array(SelectInternalMcpCatalogSchema),
        ),
      },
    },
    async ({ params: { catalogId } }, reply) => {
      const parent = await InternalMcpCatalogModel.findById(catalogId, {
        expandSecrets: false,
      });
      if (!parent) {
        throw new ApiError(404, "Catalog item not found");
      }
      if (parent.parentCatalogItemId !== null) {
        throw new ApiError(
          400,
          "Children can only be listed under root catalog items",
        );
      }
      return reply.send(await InternalMcpCatalogModel.findChildren(catalogId));
    },
  );

  fastify.post(
    "/api/internal_mcp_catalog/:catalogId/children",
    {
      schema: {
        operationId: RouteId.CreateCatalogChild,
        description:
          'Create a child catalog item ("preset" in UI) under a parent. ' +
          "Inherits all template columns from parent.",
        tags: ["MCP Catalog"],
        params: z.object({
          catalogId: UuidIdSchema,
        }),
        body: CreateChildCatalogSchema,
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
      },
    },
    async (request, reply) => {
      const { catalogId } = request.params;
      const { presetEntryId, presetFieldValues } = request.body;

      const parent = await InternalMcpCatalogModel.findById(catalogId, {
        expandSecrets: false,
      });
      if (!parent) {
        throw new ApiError(404, "Catalog item not found");
      }
      if (parent.parentCatalogItemId !== null) {
        throw new ApiError(
          400,
          "Children can only be created under root catalog items",
        );
      }

      await assertCanEditCatalogPresets(parent, request);

      const entry = await McpPresetEntryModel.findByIdForOrganization(
        presetEntryId,
        request.organizationId,
      );
      if (!entry) {
        throw new ApiError(404, "Preset entry not found");
      }

      const existingChildren = await InternalMcpCatalogModel.findChildren(
        parent.id,
      );
      if (existingChildren.some((c) => c.presetEntryId === entry.id)) {
        throw new ApiError(409, `${entry.name} is already configured.`);
      }

      try {
        InternalMcpCatalogModel.validateFieldValuesAgainstCatalog(
          parent,
          presetFieldValues,
        );
      } catch (e) {
        throw new ApiError(400, (e as Error).message);
      }

      const childName = toDns1123Label(entry.name);
      const composedName = `${parent.name}-${childName}`;
      const { nonSecretFieldValues, presetSecretId } =
        await partitionPresetFieldValuesAndUpsertSecrets({
          parent,
          catalogRow: { name: composedName, presetSecretId: null },
          incoming: presetFieldValues ?? {},
        });

      const childInsert = {
        ...pickSyncableFields(parent),
        // Model.create will overwrite `name` with the composed value; we set it
        // here only so the InsertInternalMcpCatalog schema's notNull constraint
        // is satisfied at the type level.
        name: composedName,
        childName,
        presetEntryId: entry.id,
        presetFieldValues: nonSecretFieldValues,
        presetSecretId,
        parentCatalogItemId: parent.id,
        scope: parent.scope,
      };

      const child = await InternalMcpCatalogModel.create(childInsert, {
        organizationId: parent.organizationId ?? request.organizationId,
        authorId: request.user.id,
      });

      return reply.send(child);
    },
  );

  fastify.patch(
    "/api/internal_mcp_catalog/:catalogId/children/:childId",
    {
      schema: {
        operationId: RouteId.UpdateCatalogChild,
        description:
          'Update a child catalog item ("preset" in UI). Only ' +
          "`presetFieldValues` may be edited; template fields cascade from parent " +
          "and the name is immutable after creation.",
        tags: ["MCP Catalog"],
        params: z.object({
          catalogId: UuidIdSchema,
          childId: UuidIdSchema,
        }),
        body: UpdateChildCatalogSchema,
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
      },
    },
    async (request, reply) => {
      const { catalogId, childId } = request.params;
      const { presetFieldValues } = request.body;

      const parent = await InternalMcpCatalogModel.findById(catalogId, {
        expandSecrets: false,
      });
      if (!parent || parent.parentCatalogItemId !== null) {
        throw new ApiError(404, "Parent catalog item not found");
      }

      await assertCanEditCatalogPresets(parent, request);

      const originalChild = await InternalMcpCatalogModel.findById(childId);
      if (!originalChild || originalChild.parentCatalogItemId !== parent.id) {
        throw new ApiError(404, "Child catalog item not found");
      }

      const updates: Record<string, unknown> = {};
      if (presetFieldValues !== undefined) {
        // Lenient filter (not the strict validator used on create / install):
        // when a parent edit flips a field's scope from `promptOnPreset:
        // true` to non-preset, the cascade syncs the parent's localConfig
        // template down to children but does NOT scrub their existing
        // `preset_field_values` jsonb. The frontend's preset editor copies
        // the row's full presetFieldValues into local state and re-sends
        // them on save, so without this filter every PATCH after a parent
        // scope flip would 400 ("Fields not configured for preset
        // overrides: …") and silently drop the user's new value.
        //
        // As a beneficial side effect, every successful PATCH garbage-
        // collects the orphan keys from the row's jsonb (see Model.update
        // call below — `presetFieldValues` is replaced wholesale with the
        // filtered set).
        const sanitized =
          InternalMcpCatalogModel.filterFieldValuesToPresetScope(
            parent,
            presetFieldValues,
          );

        const { nonSecretFieldValues, presetSecretId } =
          await partitionPresetFieldValuesAndUpsertSecrets({
            parent,
            catalogRow: {
              name: originalChild.name,
              presetSecretId: originalChild.presetSecretId,
            },
            incoming: sanitized,
          });
        updates.presetFieldValues = nonSecretFieldValues;
        if (presetSecretId !== originalChild.presetSecretId) {
          updates.presetSecretId = presetSecretId;
        }
      }

      const updatedChild = await InternalMcpCatalogModel.update(
        childId,
        updates,
      );
      if (!updatedChild) {
        throw new ApiError(404, "Child catalog item not found");
      }

      // Reinstall installs that point at this child if preset values changed.
      await cascadeReinstallForCatalog(originalChild, updatedChild);

      return reply.send(updatedChild);
    },
  );

  fastify.delete(
    "/api/internal_mcp_catalog/:catalogId/children/:childId",
    {
      schema: {
        operationId: RouteId.DeleteCatalogChild,
        description: 'Delete a child catalog item ("preset" in UI)',
        tags: ["MCP Catalog"],
        params: z.object({
          catalogId: UuidIdSchema,
          childId: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async (request, reply) => {
      const { catalogId, childId } = request.params;
      const child = await InternalMcpCatalogModel.findById(childId, {
        expandSecrets: false,
      });
      if (!child || child.parentCatalogItemId !== catalogId) {
        throw new ApiError(404, "Child catalog item not found");
      }

      const parent = await InternalMcpCatalogModel.findById(catalogId, {
        expandSecrets: false,
      });
      if (!parent) {
        throw new ApiError(404, "Parent catalog item not found");
      }

      await assertCanEditCatalogPresets(parent, request);

      await deleteCatalogSecretsCascade(child);

      return reply.send({
        success: await InternalMcpCatalogModel.delete(childId),
      });
    },
  );

  fastify.get(
    "/api/internal_mcp_catalog/labels/values",
    {
      schema: {
        operationId: RouteId.GetInternalMcpCatalogLabelValues,
        description: "Get all label values for catalog items",
        tags: ["MCP Catalog"],
        querystring: z.object({
          key: z.string().optional().describe("Filter values by label key"),
        }),
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ query: { key } }, reply) => {
      return reply.send(
        key
          ? await McpCatalogLabelModel.getValuesByKey(key)
          : await McpCatalogLabelModel.getAllValues(),
      );
    },
  );
};

/**
 * Mirror catalog item permissions - preset scoped fields could be added or
 * edited by same person who can edit catalog item.
 */
async function assertCanEditCatalogPresets(
  parent: InternalMcpCatalog,
  request: FastifyRequest,
): Promise<void> {
  const { success: isAdmin } = await hasPermission(
    { mcpServerInstallation: ["admin"] },
    request.headers,
  );
  if (isAdmin) return;
  if (parent.scope !== "personal" || parent.authorId !== request.user.id) {
    throw new ApiError(
      403,
      "You can only edit presets on your own personal catalog items",
    );
  }
}

/**
 * Ownership model:
 *   - clientSecretId / localConfigSecretId are owned by the parent row.
 *     Children store the same UUID in their columns for read-path convenience
 *     (so a preset install can resolve OAuth and local-env secrets without
 *     walking up to the parent), but they do not own those secret bags.
 *   - presetSecretId is per-row: parent has its own default-preset bag; each
 *     child has its own overlay bag.
 *
 * Therefore deleting a child must only delete the child's presetSecretId;
 * deleting the parent deletes the parent-owned bags plus every child's
 * presetSecretId.
 */
async function deleteCatalogSecretsCascade(
  item: InternalMcpCatalog,
): Promise<void> {
  const ids = new Set<string>();

  if (item.parentCatalogItemId === null) {
    if (item.clientSecretId) ids.add(item.clientSecretId);
    if (item.localConfigSecretId) ids.add(item.localConfigSecretId);
    if (item.presetSecretId) ids.add(item.presetSecretId);

    const children = await InternalMcpCatalogModel.findChildren(item.id);
    for (const child of children) {
      if (child.presetSecretId) ids.add(child.presetSecretId);
    }
  } else {
    if (item.presetSecretId) ids.add(item.presetSecretId);
  }

  for (const id of ids) {
    await secretManager().deleteSecret(id);
  }
}

async function upsertCatalogClientSecretValue(params: {
  clientSecretId: string | null | undefined;
  catalogName: string;
  key: string;
  value: string;
}): Promise<string> {
  const existingSecretValues = await getCatalogClientSecretValues(
    params.clientSecretId,
  );
  const secretValue = {
    ...existingSecretValues,
    [params.key]: params.value,
  };

  if (params.clientSecretId) {
    await secretManager().updateSecret(params.clientSecretId, secretValue);
    return params.clientSecretId;
  }

  const secret = await secretManager().createSecret(
    secretValue,
    `${params.catalogName}-client-secrets`,
  );
  return secret.id;
}

async function getCatalogClientSecretValues(
  clientSecretId: string | null | undefined,
): Promise<Record<string, string>> {
  if (!clientSecretId) {
    return {};
  }

  const existingSecret = await secretManager().getSecret(clientSecretId);
  if (!existingSecret?.secret) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(existingSecret.secret).map(([key, value]) => [
      key,
      String(value),
    ]),
  );
}

/**
 * Identify which preset-scoped fields on a parent catalog are secret-typed
 * (userConfig.sensitive=true OR localConfig env type=secret).
 */
function collectSecretPresetKeys(parent: InternalMcpCatalog): Set<string> {
  const keys = new Set<string>();
  for (const [key, field] of Object.entries(parent.userConfig ?? {})) {
    if (field.promptOnPreset && field.sensitive) keys.add(key);
  }
  for (const env of parent.localConfig?.environment ?? []) {
    if (env.promptOnPreset && env.type === "secret") keys.add(env.key);
  }
  return keys;
}

/**
 * Split an incoming `presetFieldValues` payload into a non-secret subset
 * (persisted on the catalog row as plain JSONB) and a secret bundle
 * (persisted via secretManager and referenced by `presetSecretId`).
 *
 * Semantics for secret fields:
 *   - non-empty incoming value → write to secret bag (replace existing key)
 *   - empty / missing incoming value → preserve existing stored secret
 *     (this mirrors how the install dialog handles already-stored secrets)
 *
 * Returns the values to persist on the row.
 */
async function partitionPresetFieldValuesAndUpsertSecrets(params: {
  parent: InternalMcpCatalog;
  catalogRow: { name: string; presetSecretId: string | null };
  incoming: PresetFieldValues;
}): Promise<{
  nonSecretFieldValues: PresetFieldValues;
  presetSecretId: string | null;
}> {
  const { parent, catalogRow, incoming } = params;
  const secretKeys = collectSecretPresetKeys(parent);

  const nonSecretFieldValues: PresetFieldValues = {};
  const incomingSecretValues: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (secretKeys.has(key)) {
      if (value !== undefined && value !== null && value !== "") {
        incomingSecretValues[key] = String(value);
      }
    } else {
      nonSecretFieldValues[key] = value;
    }
  }

  let existingBag: Record<string, unknown> = {};
  if (catalogRow.presetSecretId) {
    const existing = await secretManager().getSecret(catalogRow.presetSecretId);
    if (existing?.secret) existingBag = existing.secret;
  }

  const mergedBag = { ...existingBag, ...incomingSecretValues };

  let presetSecretId = catalogRow.presetSecretId;
  if (Object.keys(mergedBag).length > 0) {
    if (presetSecretId) {
      await secretManager().updateSecret(presetSecretId, mergedBag);
    } else {
      const secret = await secretManager().createSecret(
        mergedBag,
        `${catalogRow.name}-preset-secrets`,
      );
      presetSecretId = secret.id;
    }
  }

  return { nonSecretFieldValues, presetSecretId };
}

async function cascadeReinstallForCatalog(
  originalCatalogItem: InternalMcpCatalog,
  catalogItem: InternalMcpCatalog,
): Promise<void> {
  const installedServers = await McpServerModel.findByCatalogId(catalogItem.id);
  if (installedServers.length === 0) return;

  if (requiresNewUserInputForReinstall(originalCatalogItem, catalogItem)) {
    logger.info(
      { catalogId: catalogItem.id, serverCount: installedServers.length },
      "Catalog edit requires new user input - marking servers for manual reinstall",
    );
    for (const server of installedServers) {
      await McpServerModel.update(server.id, { reinstallRequired: true });
    }
    return;
  }

  logger.info(
    { catalogId: catalogItem.id, serverCount: installedServers.length },
    "Catalog edit does not require new user input - auto-reinstalling servers",
  );

  setImmediate(async () => {
    try {
      for (const server of installedServers) {
        try {
          await McpServerModel.update(server.id, {
            localInstallationStatus: "pending",
            localInstallationError: null,
          });
          broadcastMcpInstallationStatus(server.id, "pending", null);
          await autoReinstallServer(server, catalogItem);
          await McpServerModel.update(server.id, {
            localInstallationStatus: "success",
            localInstallationError: null,
          });
          broadcastMcpInstallationStatus(server.id, "success", null);
          logger.info(
            { serverId: server.id, serverName: server.name },
            "Auto-reinstalled MCP server successfully",
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          logger.error(
            { err: error, serverId: server.id, serverName: server.name },
            "Failed to auto-reinstall MCP server - marking for manual reinstall",
          );
          await McpServerModel.update(server.id, {
            reinstallRequired: true,
            localInstallationStatus: "error",
            localInstallationError: errorMessage,
          });
          broadcastMcpInstallationStatus(server.id, "error", errorMessage);
        }
      }
    } catch (error) {
      logger.error(
        { err: error, catalogId: catalogItem.id },
        "Unexpected error during auto-reinstall batch - some servers may need manual reinstall",
      );
    }
  });
}

/**
 * Coerce an org-level preset entry name (e.g. "Production EU") into a DNS-1123
 * label suitable for use as a K8s resource name component. The display name on
 * the org-structure page still uses the original entry value.
 */
function toDns1123Label(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function pickSyncableFields(parent: InternalMcpCatalog): SyncableCatalogFields {
  return {
    version: parent.version,
    description: parent.description,
    instructions: parent.instructions,
    repository: parent.repository,
    installationCommand: parent.installationCommand,
    requiresAuth: parent.requiresAuth,
    authDescription: parent.authDescription,
    authFields: parent.authFields,
    serverType: parent.serverType,
    multitenant: parent.multitenant,
    serverUrl: parent.serverUrl,
    docsUrl: parent.docsUrl,
    clientSecretId: parent.clientSecretId,
    localConfigSecretId: parent.localConfigSecretId,
    localConfig: parent.localConfig,
    deploymentSpecYaml: parent.deploymentSpecYaml,
    userConfig: parent.userConfig,
    oauthConfig: parent.oauthConfig,
    enterpriseManagedConfig: parent.enterpriseManagedConfig,
    icon: parent.icon,
  };
}

export default internalMcpCatalogRoutes;
