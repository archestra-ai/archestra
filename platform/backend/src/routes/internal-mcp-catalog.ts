import {
  isBuiltInCatalogId,
  isMetadataOnlyEdit,
  isPlaywrightCatalogItem,
  RouteId,
} from "@shared";
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
  EnvironmentModel,
  InternalMcpCatalogModel,
  McpCatalogLabelModel,
  McpPresetEntryModel,
  McpServerModel,
  OrganizationModel,
  TeamModel,
  ToolModel,
} from "@/models";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import { assertCanAssignEnvironment } from "@/services/environments/environment";
import {
  autoReinstallServer,
  localExecutionConfigChanged,
  onlyForwardCompatibleEnvDiff,
  reinstallMultitenantCatalog,
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
  type UserConfigFieldDefault,
  UuidIdSchema,
} from "@/types";
import { validateValuesAgainstRegex } from "@/utils/validate-values-against-regex";
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

      // Secret FK columns are server-managed: clients submit secret values, never
      // ids. Trusting an inbound id would let a caller point the row at another
      // org's secret (which create()'s clone-secret merge would then read/write).
      restBody.clientSecretId = undefined;
      restBody.localConfigSecretId = undefined;
      restBody.presetSecretId = undefined;

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

      // Gate assigning a restricted environment. Requires
      // environment:deploy-to-restricted (environment:admin implies it).
      // Unrestricted and default (null) environments are open.
      await assertCanAssignEnvironment({
        environmentId: restBody.environmentId ?? null,
        organizationId: request.organizationId,
        canDeployToRestricted: await callerCanDeployToRestricted(
          request.headers,
        ),
      });

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
          // `rotated` is irrelevant here: no installs exist yet on create.
          const result = await upsertCatalogClientSecretValue({
            clientSecretId,
            catalogName: restBody.name,
            key: "client_secret",
            value: clientSecret,
          });
          clientSecretId = result.id;

          restBody.clientSecretId = clientSecretId;
        }
        delete restBody.oauthConfig.client_secret;
      }

      const enterpriseManagedClientSecretOverride =
        restBody.enterpriseManagedConfig?.clientSecretOverride;
      if (enterpriseManagedClientSecretOverride) {
        const result = await upsertCatalogClientSecretValue({
          clientSecretId,
          catalogName: restBody.name,
          key: ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY,
          value: enterpriseManagedClientSecretOverride,
        });
        clientSecretId = result.id;

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

      // Default-preset values supplied alongside the create payload need the
      // same secret-partitioning treatment as PUT and child routes — keys
      // flagged sensitive on a `promptOnPreset` userConfig field land in
      // `preset_secret_id`'s bag rather than plaintext `preset_field_values`
      // jsonb. Skipping this here would let a single root POST persist a
      // sensitive preset value in plaintext.
      if (restBody.presetFieldValues !== undefined) {
        let parentForPartition: InternalMcpCatalog;
        if (restBody.parentCatalogItemId) {
          // Root POST creating a child (rare — children are normally created
          // via POST /:id/children). Partition against the actual parent's
          // userConfig, not the incoming row.
          const realParent = await InternalMcpCatalogModel.findById(
            restBody.parentCatalogItemId,
            {
              expandSecrets: false,
              userId: request.user.id,
              isAdmin: true,
              organizationId: request.organizationId,
            },
          );
          if (!realParent) {
            throw new ApiError(400, "Parent catalog item not found");
          }
          parentForPartition = realParent;
        } else {
          // Root POST creating a parent — this row IS the parent-to-be.
          parentForPartition = restBody as unknown as InternalMcpCatalog;
        }
        const { nonSecretFieldValues, presetSecretId } =
          await partitionPresetFieldValuesAndUpsertSecrets({
            parent: parentForPartition,
            catalogRow: { name: restBody.name, presetSecretId: null },
            incoming: restBody.presetFieldValues,
          });
        restBody.presetFieldValues = nonSecretFieldValues;
        if (presetSecretId) {
          (restBody as Record<string, unknown>).presetSecretId = presetSecretId;
        }
      }

      if (restBody.environmentId != null) {
        const targetEnv = await EnvironmentModel.findByIdForOrganization(
          restBody.environmentId,
          request.organizationId,
        );
        if (!targetEnv) {
          throw new ApiError(400, "Environment not found");
        }
      }
      // Clone source must resolve within the caller's org — `create` copies
      // the source's tools + guardrail policies, so an unscoped `clonedFrom`
      // would let a caller pull another org's catalog config into their own.
      if (restBody.clonedFrom) {
        const cloneSource = await InternalMcpCatalogModel.findById(
          restBody.clonedFrom,
          {
            expandSecrets: false,
            userId: request.user.id,
            isAdmin: true,
            organizationId: request.organizationId,
          },
        );
        if (!cloneSource) {
          throw new ApiError(400, "Clone source catalog item not found");
        }
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

      // Secret FK columns are server-managed (see POST): a client-supplied id
      // would otherwise be persisted onto the row, repointing it at another
      // org's secret. Secret handling below sets them from the existing row.
      restBody.clientSecretId = undefined;
      restBody.localConfigSecretId = undefined;
      restBody.presetSecretId = undefined;

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

      // A second copy of the same row WITHOUT expanded secret values, used
      // solely for the cascade-reinstall gate's snapshot comparison. The
      // expanded `originalCatalogItem` above is needed by the route body
      // downstream (env-vault construction, userConfig diffing). But the
      // gate compares `original` vs `Model.update`'s return, and
      // `Model.update` returns the raw row. Without this unexpanded
      // fetch, every PUT on a bag-bearing catalog would diff on
      // `localConfig.environment[*].value` (expanded plaintext vs stored
      // ID-ref) and cascade-reinstall on edits that didn't actually
      // touch any runtime field — including pure description edits.
      const originalCatalogItemForGate = await InternalMcpCatalogModel.findById(
        id,
        {
          userId: request.user.id,
          isAdmin,
          organizationId: request.organizationId,
          expandSecrets: false,
        },
      );
      if (!originalCatalogItemForGate) {
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

      // Catalog secret-bag value rotations are invisible to the
      // unexpanded gate snapshot (the bag content lives outside the
      // catalog row). Track here as we write to an EXISTING bag so the
      // cascade can force the auto-restart path on rotation. Covers
      // direct OAuth client_secret, enterprise-managed client-secret
      // override, non-prompted secret env-var values, and image-pull-
      // secret credential passwords. The Readonly-Vault flows always
      // delete+create the bag — that swaps the `clientSecretId` /
      // `localConfigSecretId` on the row itself, so the normal gate
      // already detects them; no override needed there.
      let catalogSharedSecretValuesRotated = false;

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
          const result = await upsertCatalogClientSecretValue({
            clientSecretId,
            catalogName: originalCatalogItem.name,
            key: "client_secret",
            value: clientSecret,
          });
          clientSecretId = result.id;
          if (result.rotated) catalogSharedSecretValuesRotated = true;

          restBody.clientSecretId = clientSecretId;
        }
        delete restBody.oauthConfig.client_secret;
      }

      const enterpriseManagedClientSecretOverride =
        restBody.enterpriseManagedConfig?.clientSecretOverride;
      if (enterpriseManagedClientSecretOverride) {
        const result = await upsertCatalogClientSecretValue({
          clientSecretId,
          catalogName: originalCatalogItem.name,
          key: ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY,
          value: enterpriseManagedClientSecretOverride,
        });
        clientSecretId = result.id;
        if (result.rotated) catalogSharedSecretValuesRotated = true;

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
              if (existingSecretValues[envVar.key] !== envVar.value) {
                catalogSharedSecretValuesRotated = true;
              }
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
                if (existingSecretValues[regcredKey] !== entry.password) {
                  catalogSharedSecretValuesRotated = true;
                }
                secretEnvVars[regcredKey] = entry.password;
                delete entry.password; // Strip from catalog template
              } else if (existingSecretValues[regcredKey]) {
                // No new password but key exists in existing secret - preserve it
                secretEnvVars[regcredKey] = existingSecretValues[regcredKey];
              }
            }
          }
        }
        // A key that lived in the existing bag but is no longer
        // referenced by either env vars or image-pull-secrets gets
        // implicitly dropped on `updateSecret` below — that's a value
        // change on the bag, so flag it as rotation.
        //
        // Gated on whether the request actually supplied either
        // local-config surface that produces bag keys. A userConfig-
        // only edit enters this `else if` branch (because the outer
        // condition matches `restBody.userConfig`) without supplying
        // a `localConfig`, leaving `secretEnvVars` empty solely
        // because there were no env-var/imagePullSecret entries to
        // iterate — not because keys were dropped. Without this
        // gate, a userConfig-only edit (e.g. adding an optional
        // header) would falsely force the auto path on a catalog
        // with any pre-existing local secret bag.
        const localBagSurfaceTouched =
          restBody.localConfig?.environment !== undefined ||
          restBody.localConfig?.imagePullSecrets !== undefined;
        if (localBagSurfaceTouched) {
          for (const existingKey of Object.keys(existingSecretValues)) {
            if (!(existingKey in secretEnvVars)) {
              catalogSharedSecretValuesRotated = true;
              break;
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

      // Default-preset values land on the parent row. Route them through
      // the secret partitioner so secret-flagged keys end up in a secret
      // bundle rather than the plaintext preset_field_values jsonb.
      //
      // Partition fires whenever EITHER (a) the request supplies new
      // presetFieldValues, OR (b) the request changes userConfig in a way
      // that flips a preset field's `sensitive` flag — a schema-only flip
      // would otherwise leave already-stored values in the wrong storage
      // (plaintext jsonb instead of the bag, or stale bag still merged
      // over jsonb by the read path).
      //
      // The partition runs against the *effective* parent — the incoming
      // userConfig / localConfig when the request supplies them,
      // otherwise the row's current values. Reading only
      // originalCatalogItem would misroute values for fields newly
      // flipped to sensitive (userConfig) or newly flipped to
      // `type: "secret"` on a prompted-on-preset env var.
      const parentForPartition: InternalMcpCatalog = {
        ...originalCatalogItem,
        userConfig: restBody.userConfig ?? originalCatalogItem.userConfig,
        localConfig: restBody.localConfig
          ? {
              ...(originalCatalogItem.localConfig ?? {}),
              ...restBody.localConfig,
            }
          : originalCatalogItem.localConfig,
      };
      // True when the set of preset-scoped *secret* keys differs between
      // the old and new effective parent — covers both surfaces:
      //   • userConfig: a field flipped `sensitive` true/false (or a
      //     promptOnPreset sensitive field was added/removed)
      //   • localConfig.environment: a `promptOnPreset` env var's
      //     `type` flipped between "secret" and anything else (or
      //     such an env var was added/removed)
      // Either kind of flip means children's already-stored preset
      // values need to be repartitioned between plaintext jsonb and
      // the secret bag, otherwise the read path returns stale data
      // from the wrong storage.
      const secretKeysChanged =
        (restBody.userConfig !== undefined ||
          restBody.localConfig !== undefined) &&
        !setsEqual(
          collectSecretPresetKeys(originalCatalogItem),
          collectSecretPresetKeys(parentForPartition),
        );
      // Enforce the org-wide default validation regex against incoming
      // default-scoped values. Symmetric to the entry-regex check on the
      // child PATCH route — without it, hitting this endpoint directly (curl,
      // stale frontend, scripts) bypasses the inline UI guard and persists
      // forbidden values into the parent's `presetFieldValues`.
      if (restBody.presetFieldValues !== undefined) {
        const org = await OrganizationModel.getById(request.organizationId);
        const defaultRegex = org?.presetEntityDefaultValidationRegex ?? null;
        if (defaultRegex) {
          const defaultLabel = org?.presetEntityDefaultLabel ?? "Default";
          try {
            validateValuesAgainstRegex(
              restBody.presetFieldValues,
              defaultRegex,
              defaultLabel,
            );
          } catch (e) {
            throw new ApiError(400, (e as Error).message);
          }
        }
      }

      let parentPresetBagRotated = false;
      if (restBody.presetFieldValues !== undefined || secretKeysChanged) {
        const repartitioned = await repartitionStoredPresetValues({
          row: {
            name: restBody.name ?? originalCatalogItem.name,
            presetFieldValues: originalCatalogItem.presetFieldValues ?? {},
            presetSecretId: originalCatalogItem.presetSecretId,
          },
          parent: parentForPartition,
          additionalIncoming: restBody.presetFieldValues,
        });
        restBody.presetFieldValues = repartitioned.presetFieldValues;
        if (
          repartitioned.presetSecretId !== originalCatalogItem.presetSecretId
        ) {
          (restBody as Record<string, unknown>).presetSecretId =
            repartitioned.presetSecretId;
        }
        if (repartitioned.bagValuesRotated) parentPresetBagRotated = true;
      }

      // When the environment assignment changes, gate it the same way create
      // does — the target must belong to this org, and a restricted environment
      // (or restricted default) requires environment:deploy-to-restricted
      // (environment:admin implies it).
      if (
        "environmentId" in restBody &&
        restBody.environmentId !== originalCatalogItem.environmentId
      ) {
        await assertCanAssignEnvironment({
          environmentId: restBody.environmentId ?? null,
          organizationId: request.organizationId,
          canDeployToRestricted: await callerCanDeployToRestricted(
            request.headers,
          ),
        });
      }

      // Detect an environment reassignment of a local catalog — it relocates
      // the pod to a different namespace.
      const relocatingLocalDeployment =
        "environmentId" in restBody &&
        restBody.environmentId !== originalCatalogItem.environmentId &&
        originalCatalogItem.serverType === "local" &&
        mcpServerRuntimeManager.isEnabled;

      // Update the catalog item
      const catalogItem = await InternalMcpCatalogModel.update(id, restBody);

      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      // Only tear down the old-namespace deployment when it will actually be
      // recreated. A single-tenant edit that ALSO requires new user input (e.g.
      // a command or prompted-env-var change in the same PUT) makes the cascade
      // mark the install reinstall-required WITHOUT recreating the pod — so
      // tearing it down here would leave the install with no running pod until a
      // manual reinstall. Multi-tenant always recreates via
      // reinstallSharedDeployment below, so it's always safe there.
      const recreatingRelocatedDeployment =
        relocatingLocalDeployment &&
        (originalCatalogItem.multitenant === true ||
          !requiresNewUserInputForReinstall(
            originalCatalogItemForGate,
            catalogItem,
          ));
      if (recreatingRelocatedDeployment) {
        // Remove the deployment(s) from the OLD namespace before recreating in
        // the new one. The old namespace is derived from `originalCatalogItem`
        // (captured before the update), so the teardown is correct even on a
        // cache-cold or cache-stale replica — unlike the recreate paths below,
        // which resolve the namespace from the now-updated row. Without this the
        // old-namespace pod is orphaned: it keeps running in a namespace the
        // catalog no longer points at, and the reconciler only scans the default
        // namespace so it never reclaims it.
        await mcpServerRuntimeManager.tearDownOldNamespaceDeployments(
          originalCatalogItem,
        );
      }

      // Recreate in the new namespace. A multi-tenant local catalog shares one
      // K8s Deployment across all installs, and a per-install restart no-ops on
      // it (the sibling guard in restartServer), so it must be recreated
      // explicitly via reinstallSharedDeployment — awaited before the cascade so
      // its per-install tool sync runs against the relocated, ready pod rather
      // than racing the recreate. Single-tenant installs are recreated by the
      // cascade's per-install restart below.
      if (
        relocatingLocalDeployment &&
        originalCatalogItem.multitenant === true
      ) {
        await mcpServerRuntimeManager.reinstallSharedDeployment(id);
      }

      // Cascade reinstall for the parent's own installs. Use the
      // unexpanded snapshot so the gate's diff isn't fooled by
      // expanded-vs-raw asymmetry on bag-bearing rows (see comment
      // above on `originalCatalogItemForGate`). Force the auto-restart
      // path when secret bag values rotated — those changes are
      // invisible to the row-diff gate, so without the override pods
      // would keep injecting the stale value until something else
      // triggered a restart.
      await cascadeReinstallForCatalog(
        originalCatalogItemForGate,
        catalogItem,
        {
          forceAutoRestart:
            catalogSharedSecretValuesRotated || parentPresetBagRotated,
        },
      );

      // Cascade syncable fields to children, then trigger reinstall for each
      // child's installs. Note: this snapshots children BEFORE updating them
      // so the original-vs-new comparison passed to the cascade helper still
      // reflects what changed.
      //
      // When the parent's userConfig change flipped a preset field's
      // sensitive flag, each child row's already-stored preset values must
      // also be re-partitioned (jsonb ↔ secret bag) against the new
      // schema. Without this, declassifying a parent field would leave
      // every child's secret bag carrying the stale value, and the
      // catalog read path would keep merging it over the children's
      // plaintext jsonb on every request.
      const children = await InternalMcpCatalogModel.findChildren(id);
      const syncableValues = pickSyncableFields(catalogItem);
      for (const originalChild of children) {
        const childUpdates: Record<string, unknown> = { ...syncableValues };
        let childBagRotated = false;
        if (secretKeysChanged) {
          const repartitioned = await repartitionStoredPresetValues({
            row: {
              name: originalChild.name,
              presetFieldValues: originalChild.presetFieldValues ?? {},
              presetSecretId: originalChild.presetSecretId,
            },
            parent: catalogItem,
          });
          childUpdates.presetFieldValues = repartitioned.presetFieldValues;
          if (repartitioned.presetSecretId !== originalChild.presetSecretId) {
            childUpdates.presetSecretId = repartitioned.presetSecretId;
          }
          if (repartitioned.bagValuesRotated) childBagRotated = true;
        }
        const updatedChild = await InternalMcpCatalogModel.update(
          originalChild.id,
          childUpdates as typeof syncableValues,
        );
        if (!updatedChild) continue;
        // Children inherit `clientSecretId` and `localConfigSecretId`
        // from the parent (see `SyncableCatalogFields`), so any rotation
        // to the parent's shared bag also affects every child install.
        await cascadeReinstallForCatalog(originalChild, updatedChild, {
          forceAutoRestart: catalogSharedSecretValuesRotated || childBagRotated,
        });
      }

      // Note: Tools are NOT deleted - they are synced during reinstall to preserve
      // policies and profile assignments

      return reply.send(catalogItem);
    },
  );

  fastify.post(
    "/api/internal_mcp_catalog/:id/reinstall",
    {
      schema: {
        operationId: RouteId.ReinstallInternalMcpCatalogItem,
        description:
          "Reinstall the shared K8s Deployment for a multi-tenant local catalog and cascade tool sync to every install.",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
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
        expandSecrets: false,
      });
      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      // Endpoint is meaningful only for multi-tenant local catalogs — these
      // are the only ones whose execution-config edits set
      // `catalogReinstallRequired`. Single-tenant / remote catalogs use the
      // per-install `mcp_server.reinstall_required` flag.
      if (!(catalogItem.multitenant && catalogItem.serverType === "local")) {
        throw new ApiError(
          400,
          "Catalog reinstall is only supported for multi-tenant local catalogs",
        );
      }

      if (!catalogItem.catalogReinstallRequired) {
        throw new ApiError(409, "Catalog has no pending reinstall");
      }

      // Mirror the catalog-edit ownership check: only users who could have
      // edited the catalog (admins, or the personal-scope owner) can
      // trigger the reinstall.
      if (
        !isAdmin &&
        (catalogItem.scope !== "personal" ||
          catalogItem.authorId !== request.user.id)
      ) {
        throw new ApiError(
          403,
          "Only catalog editors can reinstall this catalog",
        );
      }

      try {
        await reinstallMultitenantCatalog(catalogItem);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        throw new ApiError(500, errorMessage);
      }

      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/internal_mcp_catalog/:id/refresh-image",
    {
      schema: {
        operationId: RouteId.RefreshInternalMcpCatalogImage,
        description:
          "Restart all local MCP server pods for a catalog so Kubernetes pulls the current configured image. Fan-out restarts are best effort: the request succeeds when at least one target restarts successfully, while failed installs are marked with their own error status.",
        tags: ["MCP Catalog"],
        params: z.object({
          id: UuidIdSchema,
        }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
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
        expandSecrets: false,
      });
      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      if (
        !isAdmin &&
        (catalogItem.scope !== "personal" ||
          catalogItem.authorId !== request.user.id)
      ) {
        throw new ApiError(
          403,
          "Only catalog editors can restart this catalog's pods",
        );
      }

      const children =
        catalogItem.parentCatalogItemId === null
          ? await InternalMcpCatalogModel.findChildren(id)
          : [];
      const targetCatalogItems = [catalogItem, ...children].filter(
        (item) => item.serverType === "local",
      );

      if (targetCatalogItems.length === 0) {
        throw new ApiError(
          400,
          "Pod restart is only supported for local catalogs",
        );
      }

      const restartResults = await Promise.allSettled(
        targetCatalogItems.map(refreshCatalogImage),
      );
      const failures = restartResults.filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (failures.length === restartResults.length) {
        throw new ApiError(500, getSettledErrorMessage(failures[0]));
      }

      return reply.send({ success: true });
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
      const updated = await InternalMcpCatalogModel.update(id, {
        deploymentSpecYaml: null,
      });

      // Cascade-reinstall installed pods so they pick up the
      // auto-generated manifest. Without this, existing pods would keep
      // running on the (now-cleared) override until another unrelated
      // edit or manual reinstall triggered a restart. The standard
      // gate handles the decision: pods come up with the new template
      // via the auto path (no user re-prompt needed).
      if (updated) {
        await cascadeReinstallForCatalog(catalogItem, updated);
      }

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
        validateValuesAgainstRegex(
          presetFieldValues,
          entry.validationRegex,
          entry.name,
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

      // Unexpanded snapshot — same reason as `originalCatalogItemForGate`
      // in the parent PUT route: comparing an `expandSecrets: true`
      // snapshot against `Model.update`'s raw return would diff on
      // expanded secret values and cascade-reinstall on edits that
      // didn't touch any runtime field.
      const originalChild = await InternalMcpCatalogModel.findById(childId, {
        expandSecrets: false,
      });
      if (!originalChild || originalChild.parentCatalogItemId !== parent.id) {
        throw new ApiError(404, "Child catalog item not found");
      }

      const updates: Record<string, unknown> = {};
      // Preset secret bag value rotations are invisible to the
      // unexpanded gate snapshot (same `presetSecretId`, different
      // content). Track here so the cascade can force the auto-restart
      // path.
      let presetBagRotated = false;
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

        if (originalChild.presetEntryId) {
          const entry = await McpPresetEntryModel.findByIdForOrganization(
            originalChild.presetEntryId,
            request.organizationId,
          );
          if (entry?.validationRegex) {
            try {
              validateValuesAgainstRegex(
                sanitized,
                entry.validationRegex,
                entry.name,
              );
            } catch (e) {
              throw new ApiError(400, (e as Error).message);
            }
          }
        }

        const { nonSecretFieldValues, presetSecretId, bagValuesRotated } =
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
        if (bagValuesRotated) presetBagRotated = true;
      }

      const updatedChild = await InternalMcpCatalogModel.update(
        childId,
        updates,
      );
      if (!updatedChild) {
        throw new ApiError(404, "Child catalog item not found");
      }

      // Reinstall installs that point at this child if preset values changed.
      // Force the auto-restart path when the preset secret bag's content
      // rotated — that write happens against the same `presetSecretId`,
      // so the gate's row-diff can't see it and would otherwise skip
      // the cascade. Pods would keep injecting the old secret value
      // until something else triggered a restart.
      await cascadeReinstallForCatalog(originalChild, updatedChild, {
        forceAutoRestart: presetBagRotated,
      });

      return reply.send(updatedChild);
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
/**
 * Whether the caller may deploy catalog items to restricted environments.
 * Holding `environment:admin` (full environment management) implies the
 * `environment:deploy-to-restricted` capability.
 */
async function callerCanDeployToRestricted(
  headers: FastifyRequest["headers"],
): Promise<boolean> {
  const [{ success: hasAdmin }, { success: hasDeploy }] = await Promise.all([
    hasPermission({ environment: ["admin"] }, headers),
    hasPermission({ environment: ["deploy-to-restricted"] }, headers),
  ]);
  return hasAdmin || hasDeploy;
}

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

async function upsertCatalogClientSecretValue(params: {
  clientSecretId: string | null | undefined;
  catalogName: string;
  key: string;
  value: string;
}): Promise<{ id: string; rotated: boolean }> {
  const existingSecretValues = await getCatalogClientSecretValues(
    params.clientSecretId,
  );
  // `rotated` distinguishes "value actually changed on an existing bag"
  // from "writing the same value back". The cascade gate uses this to
  // decide whether to force a pod restart (the bag content lives
  // outside the catalog row, so a same-id-different-content write is
  // invisible to the row-diff gate). For new bags the caller's row
  // diff covers the cascade via the new `clientSecretId`, so `rotated`
  // is irrelevant there.
  const rotated = existingSecretValues[params.key] !== params.value;
  const secretValue = {
    ...existingSecretValues,
    [params.key]: params.value,
  };

  if (params.clientSecretId) {
    await secretManager().updateSecret(params.clientSecretId, secretValue);
    return { id: params.clientSecretId, rotated };
  }

  const secret = await secretManager().createSecret(
    secretValue,
    `${params.catalogName}-client-secrets`,
  );
  return { id: secret.id, rotated };
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
 * Returns true when the preset-secret-keys set differs between two
 * userConfig snapshots — i.e. some `promptOnPreset` field's `sensitive`
 * flag has been added, removed, or flipped. A change here invalidates the
 * routing of any preset values already stored on the row: previously-
 * plaintext keys now want the secret bag, and previously-secret keys now
 * want plaintext jsonb.
 */
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/**
 * Repartition a catalog row's currently-stored preset values against a
 * (possibly updated) parent userConfig schema. Reads both jsonb and the
 * secret bag, merges them into a single effective map (the bag wins on
 * key conflicts, matching the catalog read path's merge order), layers
 * any caller-supplied new values on top, and re-runs the standard
 * partition helper.
 *
 * Used when a userConfig schema-only PUT flips a preset field's
 * `sensitive` flag — the value already stored is now in the wrong storage
 * and would either leak via plaintext jsonb (non-sensitive → sensitive
 * flip) or surface stale via a stale `preset_secret_id` pointer
 * (sensitive → non-sensitive flip).
 */
async function repartitionStoredPresetValues(params: {
  row: {
    name: string;
    presetFieldValues: PresetFieldValues;
    presetSecretId: string | null;
  };
  parent: InternalMcpCatalog;
  additionalIncoming?: PresetFieldValues;
}): Promise<{
  presetFieldValues: PresetFieldValues;
  presetSecretId: string | null;
  bagValuesRotated: boolean;
}> {
  const rawEffective: PresetFieldValues = {
    ...(params.row.presetFieldValues ?? {}),
  };
  if (params.row.presetSecretId) {
    const bag = await secretManager().getSecret(params.row.presetSecretId);
    if (bag?.secret) {
      Object.assign(
        rawEffective,
        bag.secret as Record<string, UserConfigFieldDefault>,
      );
    }
  }
  if (params.additionalIncoming) {
    Object.assign(rawEffective, params.additionalIncoming);
  }
  // Drop values for keys that are no longer in preset scope on the
  // *current* parent userConfig. Without this, a sensitive preset field
  // that was DELETED (or moved to installation / static scope) would
  // have its stored credential value flow through partition as
  // "nonSecret" (because today's secretKeys set no longer contains it)
  // and land in plaintext `preset_field_values` jsonb — leaking the
  // credential through the very migration meant to clean it up.
  const effective = InternalMcpCatalogModel.filterFieldValuesToPresetScope(
    params.parent,
    rawEffective,
  );
  const { nonSecretFieldValues, presetSecretId, bagValuesRotated } =
    await partitionPresetFieldValuesAndUpsertSecrets({
      parent: params.parent,
      catalogRow: {
        name: params.row.name,
        presetSecretId: params.row.presetSecretId,
      },
      incoming: effective,
    });
  return {
    presetFieldValues: nonSecretFieldValues,
    presetSecretId,
    bagValuesRotated,
  };
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
  /**
   * True when (and only when) this call WROTE a different value set to
   * an EXISTING preset secret bag (same `presetSecretId`, changed
   * content). Used
   * by the cascade gate to force the auto-restart path — a same-id-
   * different-content update is invisible to the row-diff gate. New
   * bags (`presetSecretId` flips from null to a new id) and bag
   * deletions both move the row's pointer, so the gate detects them
   * naturally without this signal.
   */
  bagValuesRotated: boolean;
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

  // Drop any key in the existing bag that's no longer flagged sensitive in
  // the current parent userConfig — declassifying a field must clear its
  // stored secret value, otherwise the catalog read path's "merge secret
  // bag over preset_field_values" step would keep surfacing the stale
  // secret on top of the new plaintext value.
  const cleanedExistingBag: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(existingBag)) {
    if (secretKeys.has(key)) {
      cleanedExistingBag[key] = value;
    }
  }

  const mergedBag = { ...cleanedExistingBag, ...incomingSecretValues };
  const existingHadKeys = Object.keys(existingBag).length > 0;
  const mergedHasKeys = Object.keys(mergedBag).length > 0;

  let presetSecretId = catalogRow.presetSecretId;
  let bagValuesRotated = false;
  if (mergedHasKeys) {
    if (presetSecretId) {
      // Same-id update — detect if content actually changed before
      // signalling rotation. Compares against the *uncleaned*
      // existing bag so the "declassified key was dropped" case
      // (mergedBag missing a key the old bag had) also counts as
      // rotation.
      bagValuesRotated = !shallowEqualStringMap(existingBag, mergedBag);
      await secretManager().updateSecret(presetSecretId, mergedBag);
    } else {
      const secret = await secretManager().createSecret(
        mergedBag,
        `${catalogRow.name}-preset-secrets`,
      );
      presetSecretId = secret.id;
    }
  } else if (presetSecretId && existingHadKeys) {
    // Every key that used to live in the bag has been declassified, so the
    // bag would be empty. Delete the secret row AND clear the catalog
    // row's pointer — the preset list / install dialog UI keys on
    // `presetSecretId != null` to render "<set>" badges and to skip
    // required-prompts for preset-scoped secret fields, so leaving a
    // non-null pointer here would make the UI lie about secret values
    // still being set.
    await secretManager().deleteSecret(presetSecretId);
    presetSecretId = null;
  }

  return { nonSecretFieldValues, presetSecretId, bagValuesRotated };
}

function shallowEqualStringMap(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (String(a[k] ?? "") !== String(b[k] ?? "")) return false;
  }
  return true;
}

async function cascadeReinstallForCatalog(
  originalCatalogItem: InternalMcpCatalog,
  catalogItem: InternalMcpCatalog,
  /**
   * Force the auto-restart path past the "no restart needed" gates
   * (metadata-only, forward-compat) — used when the caller has
   * out-of-band knowledge that pods need to restart even though the
   * row looks unchanged (primarily catalog secret-bag value rotation:
   * non-prompted secret env vars, OAuth client_secret, image-pull-
   * secret passwords, default-preset sensitive values). The bag
   * content lives outside the catalog row, so the unexpanded gate
   * snapshot cannot see a value change.
   *
   * Does NOT override `requiresNewUserInputForReinstall`. If the same
   * PUT both rotates a secret AND adds a re-prompt-requiring change
   * (e.g. a new required prompted env var), the cascade must still
   * mark servers for manual reinstall — auto-restarting would bring
   * pods back without the newly-required input. The two signals are
   * orthogonal: rotation says "pods need to restart for the value to
   * propagate"; re-prompt says "no restart can succeed until the user
   * supplies a value the install doesn't have."
   */
  override?: { forceAutoRestart?: boolean },
): Promise<void> {
  const installedServers = await McpServerModel.findByCatalogId(catalogItem.id);
  if (installedServers.length === 0) return;

  // Multi-tenant local catalogs have one shared K8s Deployment across all
  // installs. Execution-config drift (image, command, args, transport) on
  // this kind of catalog is a catalog-level event — one rollout serves
  // every tenant — so we flag it on the catalog row instead of marking
  // each install reinstall-required. An admin/owner clears the flag via
  // POST /api/internal-mcp-catalog/:id/reinstall, which does the actual
  // pod recreate + tool cascade. Single-tenant catalogs continue to use
  // the per-install flag (see `requiresNewUserInputForReinstall`).
  const catalogScopeChangeOnMultitenant =
    catalogItem.multitenant === true &&
    catalogItem.serverType === "local" &&
    (localExecutionConfigChanged(originalCatalogItem, catalogItem) ||
      multitenantSharedEnvChanged(originalCatalogItem, catalogItem));

  if (catalogScopeChangeOnMultitenant) {
    logger.info(
      { catalogId: catalogItem.id, serverCount: installedServers.length },
      "Catalog execution config changed on multi-tenant local catalog - setting catalogReinstallRequired",
    );
    await InternalMcpCatalogModel.update(catalogItem.id, {
      catalogReinstallRequired: true,
    });
    // Fall through to also evaluate per-install marking: a prompt-input
    // change could have landed in the same edit and still needs per-tenant
    // input on top of the catalog-level rollout.
  }

  // Manual path is authoritative: a re-prompt edit blocks both the
  // gate-decided auto path AND the forced auto path. Run it before any
  // override branching.
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

  // If we set the catalog-level flag and nothing else needs handling per
  // install, skip the auto-cascade. The pod is still running the old
  // spec; the catalog-reinstall endpoint will recreate it and cascade
  // tool sync to every install in one shot. Without this short-circuit,
  // every install would auto-cascade against the unchanged pod, flipping
  // statuses to "success" while the catalog flag still says "reinstall
  // required" — a confusing mixed signal.
  if (catalogScopeChangeOnMultitenant) {
    logger.info(
      { catalogId: catalogItem.id },
      "Catalog reinstall pending - skipping auto-cascade; admin clicks 'Reinstall catalog' to apply",
    );
    return;
  }

  if (override?.forceAutoRestart) {
    logger.info(
      { catalogId: catalogItem.id, serverCount: installedServers.length },
      "Forced auto-restart cascade (caller signaled secret-bag value rotation)",
    );
  } else {
    // Skip the cascade when only metadata fields changed. List in
    // `shared/catalog-runtime-fields.ts`.
    //
    // Tradeoff: `originalCatalogItem` is fetched with `expandSecrets: true`
    // (the route body needs expanded secrets downstream); `Model.update`
    // returns the unexpanded row. For catalogs carrying any secret bag
    // pointer, the expanded vs unexpanded shapes differ even with no real
    // edit, so the predicate returns false and we cascade. That is the
    // safe direction (pre-fix baseline) and `hasSecretBag` in
    // `edit-catalog-dialog.tsx` mirrors it on the UI side. The
    // optimization applies cleanly to non-bag catalogs.
    if (isMetadataOnlyEdit(originalCatalogItem, catalogItem)) {
      logger.info(
        { catalogId: catalogItem.id, serverCount: installedServers.length },
        "Catalog edit is metadata-only - skipping reinstall",
      );
      return;
    }

    // Refinement gate: `isMetadataOnlyEdit` is too blunt for env-var
    // schema evolution. Adding an optional prompted env var, demoting
    // required → optional, etc. legitimately changes `localConfig.environment`
    // but doesn't invalidate any install (the existing pod's env-var
    // bindings are still valid). Without this check, a forward-compatible
    // edit would fall through to the auto-cascade path and silently restart
    // every pod. Mirrors the frontend's `envChangeRequiresReinstall` so
    // bar silence and backend behavior agree.
    if (onlyForwardCompatibleEnvDiff(originalCatalogItem, catalogItem)) {
      logger.info(
        { catalogId: catalogItem.id, serverCount: installedServers.length },
        "Catalog edit is a forward-compatible env-var change - skipping reinstall",
      );
      return;
    }

    logger.info(
      { catalogId: catalogItem.id, serverCount: installedServers.length },
      "Catalog edit does not require new user input - auto-reinstalling servers",
    );
  }

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

async function refreshCatalogImage(catalogItem: InternalMcpCatalog) {
  if (catalogItem.multitenant === true) {
    await reinstallMultitenantCatalog(catalogItem);
    return;
  }

  const installs = await McpServerModel.findByCatalogId(catalogItem.id);
  const restartResults = await Promise.allSettled(
    installs.map(async (server) => {
      await McpServerModel.update(server.id, {
        localInstallationStatus: "pending",
        localInstallationError: null,
      });
      broadcastMcpInstallationStatus(server.id, "pending", null);

      try {
        await autoReinstallServer(server, catalogItem);
        await McpServerModel.update(server.id, {
          localInstallationStatus: "success",
          localInstallationError: null,
        });
        broadcastMcpInstallationStatus(server.id, "success", null);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        logger.error(
          { err: error, serverId: server.id, catalogId: catalogItem.id },
          "Pod restart failed for MCP server install",
        );
        await McpServerModel.update(server.id, {
          localInstallationStatus: "error",
          localInstallationError: errorMessage,
        });
        broadcastMcpInstallationStatus(server.id, "error", errorMessage);
        throw error;
      }
    }),
  );
  const failures = restartResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0 && failures.length === restartResults.length) {
    throw new Error(getSettledErrorMessage(failures[0]));
  }
}

function getSettledErrorMessage(result: PromiseRejectedResult): string {
  return result.reason instanceof Error
    ? result.reason.message
    : "Unknown error";
}

/**
 * Coerce an org-level preset entry name (e.g. "Production EU") into a DNS-1123
 * label suitable for use as a K8s resource name component. The display name on
 * the org-structure page still uses the original entry value.
 */
/**
 * Non-prompted env entries land directly in the shared K8s pod's env on a
 * multi-tenant local catalog (as plain values or via the preset secret), so
 * any change to one of them requires a pod recreate. Prompted entries are
 * per-install secrets surfaced at request time — they don't live on the
 * shared pod and are tracked separately by `promptedEnvVarsChanged`, so we
 * exclude them here. Compared fields are `key + type + value` only;
 * `description`, `required`, and other metadata don't reach the pod env.
 */
function multitenantSharedEnvChanged(
  oldCatalog: InternalMcpCatalog,
  newCatalog: InternalMcpCatalog,
): boolean {
  const project = (cat: InternalMcpCatalog) =>
    (cat.localConfig?.environment ?? [])
      .filter((e) => !e.promptOnInstallation)
      .map((e) => ({ key: e.key, type: e.type, value: e.value }));
  return (
    JSON.stringify(project(oldCatalog)) !== JSON.stringify(project(newCatalog))
  );
}

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
