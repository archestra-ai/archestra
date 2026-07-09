import {
  isBuiltInCatalogId,
  isMetadataOnlyEdit,
  isPlaywrightCatalogItem,
  RouteId,
} from "@archestra/shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { hasPermission } from "@/auth";
import {
  assertMcpCatalogTeams,
  authorizeMcpCatalogScope,
  type CatalogTeamAccess,
  getCatalogWriteMembershipTeamIds,
  getMcpCatalogPermissionChecker,
  requireMcpCatalogDeletePermission,
  requireMcpCatalogModifyPermission,
  withCatalogTeamFkErrorMapped,
} from "@/auth/mcp-catalog-permissions";
import config from "@/config";
import {
  generateDeploymentYamlTemplate,
  mergeLocalConfigIntoYaml,
  validateDeploymentYaml,
} from "@/k8s/mcp-server-runtime/k8s-yaml-generator";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import logger from "@/logging";
import {
  AppModel,
  EnvironmentModel,
  InternalMcpCatalogModel,
  McpCatalogLabelModel,
  McpServerModel,
  TeamModel,
  ToolModel,
} from "@/models";
import { isByosEnabled, secretManager } from "@/secrets-manager";
import { propagateAppCatalogChange } from "@/services/apps/app-mcp-backing";
import {
  assertCanAssignEnvironment,
  assertRemoteServerUrlAllowedByNetworkPolicy,
  assertValuesMatchEnvironmentRegex,
} from "@/services/environments/environment";
import {
  flagImageApprovalRequired,
  holdInstallIfImageGated,
} from "@/services/mcp-install-policy";
import {
  autoReinstallServer,
  localExecutionConfigChanged,
  onlyForwardCompatibleEnvDiff,
  reinstallMultitenantCatalog,
  requiresNewUserInputForReinstall,
} from "@/services/mcp-reinstall";
import {
  ApiError,
  type CatalogTeamAssignment,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ENTERPRISE_MANAGED_CLIENT_SECRET_OVERRIDE_SECRET_KEY,
  InsertInternalMcpCatalogSchema,
  type InternalMcpCatalog,
  ListInternalMcpCatalogSchema,
  type LocalConfig,
  normalizeCatalogTeamInput,
  PartialUpdateInternalMcpCatalogSchema,
  SelectInternalMcpCatalogSchema,
  UuidIdSchema,
} from "@/types";
import { broadcastMcpInstallationStatus } from "@/websocket";

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
          // Apps are hidden from the registry but assignable to a gateway, so the
          // capabilities picker opts in to their backing catalogs here.
          includeApps: z.coerce.boolean().optional(),
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
      const opts = {
        expandSecrets: false,
        userId: request.user.id,
        isAdmin,
        organizationId: request.organizationId,
      };
      // App backings are gated by `app:read`, not this route's `mcpRegistry:read`,
      // so only surface them to callers who could see them on the Apps page.
      const includeApps =
        request.query.includeApps === true &&
        (await hasPermission({ app: ["read"] }, request.headers)).success;
      if (!includeApps) {
        const list = await InternalMcpCatalogModel.findAll(opts);
        const approvalRequired = await flagImageApprovalRequired(
          list,
          request.organizationId,
        );
        return reply.send(
          list.map((item) => ({
            ...item,
            imageApprovalRequired: approvalRequired.has(item.id),
          })),
        );
      }
      // App backings carry an `appId` so the registry can link/manage the app.
      // Only the (few) serverType:"app" rows need the lookup, so the default
      // path above never pays for it.
      const items = await InternalMcpCatalogModel.findAllWithApps(opts);
      const appCatalogIds = items
        .filter((item) => item.serverType === "app")
        .map((item) => item.id);
      const appIdByCatalog =
        await AppModel.getAppIdsByCatalogIds(appCatalogIds);
      const approvalRequired = await flagImageApprovalRequired(
        items,
        request.organizationId,
      );
      return reply.send(
        items.map((item) => ({
          ...item,
          imageApprovalRequired: approvalRequired.has(item.id),
          ...(item.serverType === "app"
            ? { appId: appIdByCatalog.get(item.id) ?? null }
            : {}),
        })),
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

      // serverType:"app" catalogs are created and owned by the Apps flow
      // (their app row, version store, and connector identity live in `apps`).
      // Reject them here so the generic registry can't mint an orphan app
      // catalog with no backing app.
      if (restBody.serverType === "app") {
        throw new ApiError(
          400,
          "App catalog entities are managed via the Apps API.",
        );
      }

      // Secret FK columns are server-managed: clients submit secret values, never
      // ids. Trusting an inbound id would let a caller point the row at another
      // org's secret (which create()'s clone-secret merge would then read/write).
      restBody.clientSecretId = undefined;
      restBody.localConfigSecretId = undefined;

      // Enforce scope restrictions (3-tier model shared with agents/skills):
      // org → admin only; team → admin of one of the assigned teams, and
      // membership in all of them; personal → the author.
      const checker = await getMcpCatalogPermissionChecker({
        userId: request.user.id,
        organizationId: request.organizationId,
      });

      restBody.scope = restBody.scope ?? "personal";
      const requestedTeams =
        restBody.scope === "team"
          ? normalizeCatalogTeamInput(restBody.teams ?? [])
          : [];
      const requestedTeamIds = requestedTeams.map((team) => team.id);
      const [userTeamIds, writeMembershipTeamIds] = checker.isAdmin
        ? [[], []]
        : await Promise.all([
            TeamModel.getUserTeamIds(request.user.id),
            getCatalogWriteMembershipTeamIds(request.user.id),
          ]);
      authorizeMcpCatalogScope({
        checker,
        scope: restBody.scope,
        authorId: request.user.id,
        requestedTeamIds,
        userTeamIds,
        writeMembershipTeamIds,
        userId: request.user.id,
      });
      if (restBody.scope !== "team") {
        delete restBody.teams;
      } else {
        restBody.teams = requestedTeams;
      }
      await assertMcpCatalogTeams({
        scope: restBody.scope,
        teamIds: requestedTeamIds,
        organizationId: request.organizationId,
      });

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

      if (restBody.environmentId != null) {
        const targetEnv = await EnvironmentModel.findByIdForOrganization(
          restBody.environmentId,
          request.organizationId,
        );
        if (!targetEnv) {
          throw new ApiError(400, "Environment not found");
        }
      }
      // Enforce the governing environment's allowlist regex against the
      // admin-entered config values being persisted: static (non-prompted) env
      // var values and non-secret userConfig defaults (the value a static header
      // persists, and the suggested value a prompted field shows). Secrets are
      // exempt; secret env values are extracted above.
      await assertValuesMatchEnvironmentRegex({
        environmentId: restBody.environmentId ?? null,
        organizationId: request.organizationId,
        valueSets: [
          collectStaticEnvValues(restBody.localConfig?.environment),
          collectStaticUserConfigValues(restBody.userConfig),
        ],
      });
      // A remote server is reached over HTTP from the backend; block creating it
      // in an environment whose egress policy would forbid that outbound hop.
      await assertRemoteServerUrlAllowedByNetworkPolicy({
        serverType: restBody.serverType,
        serverUrl: restBody.serverUrl ?? null,
        environmentId: restBody.environmentId ?? null,
        organizationId: request.organizationId,
      });
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

      const catalogItem = await withCatalogTeamFkErrorMapped(() =>
        InternalMcpCatalogModel.create(restBody, {
          organizationId: request.organizationId,
          authorId: request.user.id,
        }),
      );
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

      const checker = await getMcpCatalogPermissionChecker({
        userId: request.user.id,
        organizationId: request.organizationId,
      });
      const isAdmin = checker.isAdmin;

      // Get the original catalog item to check if name or serverUrl changed
      const originalCatalogItem = await InternalMcpCatalogModel.findById(id, {
        userId: request.user.id,
        isAdmin,
        organizationId: request.organizationId,
      });

      if (!originalCatalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      // App backing catalogs are owned by the Apps flow. Through this generic
      // endpoint, only visibility (scope/teams) and environment may change: lock
      // the server type to "app" and drop every deploy/credential field so the
      // catalog can't be flipped to a deployable type or have an install command
      // injected (then later installed). The normal scope/team/environment
      // authorization below still applies; the change is propagated to the linked
      // app + server after the update.
      const isAppCatalog = originalCatalogItem.serverType === "app";
      // A non-app catalog cannot be converted into an app (the inverse of the
      // create guard): an "app" catalog only makes sense when an actual app row
      // and the `open` launch tool back it, which this path can't create.
      if (!isAppCatalog && restBody.serverType === "app") {
        throw new ApiError(400, "Catalog items cannot be converted to apps.");
      }
      if (isAppCatalog) {
        restBody.serverType = "app";
        // Name is app-owned (edited via /api/apps, which syncs it here) — never
        // changed through the generic catalog endpoint.
        restBody.name = undefined;
        restBody.localConfig = undefined;
        restBody.installationCommand = undefined;
        restBody.oauthConfig = undefined;
        restBody.enterpriseManagedConfig = undefined;
        restBody.serverUrl = undefined;
        restBody.userConfig = undefined;
        restBody.authFields = undefined;
        restBody.requiresAuth = undefined;
        restBody.deploymentSpecYaml = undefined;
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

      const [userTeamIds, writeMembershipTeamIds] = checker.isAdmin
        ? [[], []]
        : await Promise.all([
            TeamModel.getUserTeamIds(request.user.id),
            getCatalogWriteMembershipTeamIds(request.user.id),
          ]);
      const existingTeams = originalCatalogItem.teams;

      // Gate the right to modify this item at its CURRENT scope. This lets an
      // admin of one of the item's `write` teams edit it, and still blocks
      // editing someone else's personal item or a `use`-only team's item.
      requireMcpCatalogModifyPermission({
        checker,
        scope: originalCatalogItem.scope,
        authorId: originalCatalogItem.authorId,
        catalogTeams: existingTeams,
        writeMembershipTeamIds,
        userId: request.user.id,
      });

      // Re-authorize and re-sync teams only when scope, team assignments, or
      // their access levels actually change. A content-only edit that echoes
      // the existing teams must not 403 a non-admin author/team-admin or
      // needlessly rewrite rows.
      const newScope = restBody.scope ?? originalCatalogItem.scope;
      // Shared items are one-way: demoting team/org back to personal would yank
      // the item from everyone it was shared with. Mirrors the agent route.
      if (newScope === "personal" && originalCatalogItem.scope !== "personal") {
        throw new ApiError(400, "Shared catalog items cannot be made personal");
      }
      const newTeams: CatalogTeamAssignment[] =
        newScope === "team"
          ? normalizeCatalogTeamInput(restBody.teams ?? existingTeams)
          : [];
      const newTeamIds = newTeams.map((team) => team.id);
      const scopeChanged = newScope !== originalCatalogItem.scope;
      const teamsChanged =
        newScope === "team" && !sameTeamAssignments(newTeams, existingTeams);
      if (scopeChanged || teamsChanged) {
        authorizeMcpCatalogScope({
          checker,
          scope: newScope,
          authorId: originalCatalogItem.authorId,
          requestedTeamIds: newTeamIds,
          userTeamIds,
          writeMembershipTeamIds,
          userId: request.user.id,
        });
        await assertMcpCatalogTeams({
          scope: newScope,
          teamIds: newTeamIds,
          organizationId: request.organizationId,
        });
      }

      // Only rewrite team assignments when scope/teams/levels actually change;
      // undefined leaves the existing rows untouched.
      restBody.teams = scopeChanged || teamsChanged ? newTeams : undefined;

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

      // When the environment assignment changes, gate it the same way create
      // does — the target must belong to this org, and a restricted environment
      // (or restricted default) requires environment:deploy-to-restricted
      // (environment:admin implies it).
      const environmentChanged =
        "environmentId" in restBody &&
        restBody.environmentId !== originalCatalogItem.environmentId;
      if (environmentChanged) {
        await assertCanAssignEnvironment({
          environmentId: restBody.environmentId ?? null,
          organizationId: request.organizationId,
          canDeployToRestricted: await callerCanDeployToRestricted(
            request.headers,
          ),
        });
      }

      // Enforce the governing environment's allowlist regex. Validate when the
      // local config / userConfig changes (incoming values) or the environment
      // changes (re-check the EFFECTIVE persisted values against the new env, so
      // moving an item into a stricter env catches values stored under the old
      // one).
      if (
        environmentChanged ||
        restBody.localConfig !== undefined ||
        restBody.userConfig !== undefined
      ) {
        await assertValuesMatchEnvironmentRegex({
          environmentId: ("environmentId" in restBody
            ? restBody.environmentId
            : originalCatalogItem.environmentId) as string | null,
          organizationId: request.organizationId,
          valueSets: [
            collectStaticEnvValues(
              restBody.localConfig?.environment ??
                originalCatalogItem.localConfig?.environment,
            ),
            collectStaticUserConfigValues(
              restBody.userConfig ?? originalCatalogItem.userConfig,
            ),
          ],
        });
      }

      // Re-validate a remote server's URL against its environment's egress
      // policy when the URL, server type, or environment changes. Unchanged
      // existing servers are grandfathered (no retroactive block).
      if (
        environmentChanged ||
        restBody.serverUrl !== undefined ||
        restBody.serverType !== undefined
      ) {
        await assertRemoteServerUrlAllowedByNetworkPolicy({
          serverType: restBody.serverType ?? originalCatalogItem.serverType,
          serverUrl:
            (restBody.serverUrl !== undefined
              ? restBody.serverUrl
              : originalCatalogItem.serverUrl) ?? null,
          environmentId: ("environmentId" in restBody
            ? restBody.environmentId
            : originalCatalogItem.environmentId) as string | null,
          organizationId: request.organizationId,
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
      const catalogItem = await withCatalogTeamFkErrorMapped(() =>
        InternalMcpCatalogModel.update(id, restBody),
      );

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

      // Trusted-image gate: when a non-privileged author swaps the image to an
      // untrusted one, hold the new image for admin approval instead of rolling
      // it out. Flip the catalog flag to `pending` and skip the auto-reinstall so
      // every install keeps running its old, approved image until an admin
      // approves — rather than auto-reinstalling onto an image that the gate
      // would reject and marking the install failed.
      const imageHeldForApproval = catalogItem.organizationId
        ? await holdInstallIfImageGated({
            catalogItem,
            organizationId: catalogItem.organizationId,
          })
        : false;

      if (imageHeldForApproval) {
        logger.info(
          { catalogId: id },
          "Catalog image edited to an untrusted image by a non-privileged author - holding for admin approval; skipping auto-reinstall",
        );
      } else {
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
            forceAutoRestart: catalogSharedSecretValuesRotated,
          },
        );
      }

      // Note: Tools are NOT deleted - they are synced during reinstall to preserve
      // policies and profile assignments

      // Keep an app's linked row + backing server in sync with the catalog edit.
      if (isAppCatalog) {
        await propagateAppCatalogChange(id, {
          scope: catalogItem.scope,
          environmentId: catalogItem.environmentId,
          description: catalogItem.description,
        });
      }

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

      const checker = await getMcpCatalogPermissionChecker({
        userId: request.user.id,
        organizationId: request.organizationId,
      });

      const catalogItem = await InternalMcpCatalogModel.findById(id, {
        userId: request.user.id,
        isAdmin: checker.isAdmin,
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
      // edited the catalog (admins, the author, or an admin of one of the
      // item's `write` teams) can trigger the reinstall.
      requireMcpCatalogModifyPermission({
        checker,
        scope: catalogItem.scope,
        authorId: catalogItem.authorId,
        catalogTeams: catalogItem.teams,
        writeMembershipTeamIds: checker.isAdmin
          ? []
          : await getCatalogWriteMembershipTeamIds(request.user.id),
        userId: request.user.id,
      });

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

      const checker = await getMcpCatalogPermissionChecker({
        userId: request.user.id,
        organizationId: request.organizationId,
      });

      const catalogItem = await InternalMcpCatalogModel.findById(id, {
        userId: request.user.id,
        isAdmin: checker.isAdmin,
        organizationId: request.organizationId,
        expandSecrets: false,
      });
      if (!catalogItem) {
        throw new ApiError(404, "Catalog item not found");
      }

      requireMcpCatalogModifyPermission({
        checker,
        scope: catalogItem.scope,
        authorId: catalogItem.authorId,
        catalogTeams: catalogItem.teams,
        writeMembershipTeamIds: checker.isAdmin
          ? []
          : await getCatalogWriteMembershipTeamIds(request.user.id),
        userId: request.user.id,
      });

      const targetCatalogItems = [catalogItem].filter(
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

  // === Image approval (trusted-image-registry gate) ===

  fastify.get(
    "/api/internal_mcp_catalog/pending-image-approval",
    {
      schema: {
        operationId: RouteId.ListPendingImageApprovalCatalogItems,
        description:
          "List local catalog items in the org whose custom image is awaiting admin approval (blocked by the target environment's trusted image registries).",
        tags: ["MCP Catalog"],
        response: constructResponseSchema(
          z.array(SelectInternalMcpCatalogSchema),
        ),
      },
    },
    async (request, reply) => {
      return reply.send(
        await InternalMcpCatalogModel.listPendingImageApproval(
          request.organizationId,
        ),
      );
    },
  );

  fastify.post(
    "/api/internal_mcp_catalog/:id/approve",
    {
      schema: {
        operationId: RouteId.ApproveCatalogItemImage,
        description:
          "Approve a local catalog item's image so its installs proceed. Requires mcpServerInstallation:admin.",
        tags: ["MCP Catalog"],
        params: z.object({ id: UuidIdSchema }),
        response: constructResponseSchema(SelectInternalMcpCatalogSchema),
      },
    },
    async (request, reply) => {
      const catalogItem = await assertImageApprovable(
        request.params.id,
        request.organizationId,
      );
      const approved = await InternalMcpCatalogModel.approveImage({
        id: catalogItem.id,
        reviewedBy: request.user.id,
      });
      if (!approved) {
        throw new ApiError(404, "Catalog item not found");
      }
      logger.info(
        { catalogId: catalogItem.id, reviewedBy: request.user.id },
        "Catalog item image approved",
      );
      // Release the auto-reinstall the gated edit deferred: roll existing
      // installs onto the now-approved image (mirrors the un-gated image edit,
      // which auto-reinstalls). A fresh, never-installed catalog item has no
      // installs, so this is a no-op for the install-from-scratch flow.
      await reinstallApprovedImage(approved);
      return reply.send(approved);
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

      // App-backed catalogs are created and removed through the Apps lifecycle;
      // deleting one here would orphan its app. (Mirrors the install/create guards.)
      if (catalogItem.serverType === "app") {
        throw new ApiError(
          400,
          "App-backed catalog items are managed through the Apps API and cannot be deleted here.",
        );
      }

      // Deletion cascades to every install and secret bag: reserved for admins
      // and a personal item's author, never conferred by a team `write` level.
      requireMcpCatalogDeletePermission({
        checker: { isAdmin },
        scope: catalogItem.scope,
        authorId: catalogItem.authorId,
        userId: request.user.id,
      });

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

      // App-backed catalogs are managed through the Apps lifecycle (see above).
      if (catalogItem.serverType === "app") {
        throw new ApiError(
          400,
          "App-backed catalog items are managed through the Apps API and cannot be deleted here.",
        );
      }

      // Deletion cascades to every install and secret bag: reserved for admins
      // and a personal item's author, never conferred by a team `write` level.
      const { success: isAdmin } = await hasPermission(
        { mcpServerInstallation: ["admin"] },
        request.headers,
      );
      requireMcpCatalogDeletePermission({
        checker: { isAdmin },
        scope: catalogItem.scope,
        authorId: catalogItem.authorId,
        userId: request.user.id,
      });

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
          z.array(
            z.object({
              name: z.string(),
              registryServers: z.array(z.string()),
            }),
          ),
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
 * Whether a requested team list leaves the stored assignments untouched. An
 * entry carrying no level cannot change one (the sync preserves what is
 * stored), so only an explicit, differing level counts as a change.
 */
function sameTeamAssignments(
  requested: CatalogTeamAssignment[],
  current: CatalogTeamAccess[],
): boolean {
  if (requested.length !== current.length) return false;
  const currentLevels = new Map(current.map((team) => [team.id, team.level]));
  return requested.every((team) => {
    const currentLevel = currentLevels.get(team.id);
    if (currentLevel === undefined) return false;
    return team.level === undefined || team.level === currentLevel;
  });
}

/**
 * Collect the admin-set static config values an environment's validation regex
 * governs: plain-text, non-prompted env vars with a stored value. Secret,
 * prompted, boolean, and number entries are excluded — secrets aren't policy
 * targets, prompted values are validated at install, and the rule is meant for
 * free-text values.
 */
function collectStaticEnvValues(
  environment: LocalConfig["environment"],
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const envVar of environment ?? []) {
    if (
      envVar.type === "plain_text" &&
      !envVar.promptOnInstallation &&
      typeof envVar.value === "string"
    ) {
      values[envVar.key] = envVar.value;
    }
  }
  return values;
}

/**
 * Collect the non-secret, free-text userConfig default values an environment's
 * allowlist regex governs — the value a static header persists and the
 * suggested value a prompted field carries (both stored in `default`). Secret
 * and number/boolean fields are excluded; the rule targets free-text values.
 */
function collectStaticUserConfigValues(
  userConfig:
    | Record<string, { type?: string; sensitive?: boolean; default?: unknown }>
    | null
    | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, def] of Object.entries(userConfig ?? {})) {
    if (def.sensitive || def.type === "number" || def.type === "boolean") {
      continue;
    }
    if (typeof def.default === "string" && def.default !== "") {
      values[key] = def.default;
    }
  }
  return values;
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
   * secret passwords). The bag content lives outside the catalog row,
   * so the unexpanded gate snapshot cannot see a value change.
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

  autoReinstallInstallsInBackground(installedServers, catalogItem);
}

/**
 * Roll every install of a single-tenant catalog onto its current spec in the
 * background, broadcasting status per install. Shared by the catalog-edit auto
 * cascade and image approval (which releases the auto-reinstall a gated edit
 * deferred).
 */
function autoReinstallInstallsInBackground(
  installedServers: Awaited<ReturnType<typeof McpServerModel.findByCatalogId>>,
  catalogItem: InternalMcpCatalog,
): void {
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
 * Release the auto-reinstall that a gated catalog edit deferred: once an admin
 * approves the image, roll every install onto it. Single-tenant catalogs
 * auto-reinstall each pod; multi-tenant catalogs flag `catalogReinstallRequired`
 * for the admin's "Reinstall catalog" — the non-gated multi-tenant edit path is
 * manual by design too.
 */
async function reinstallApprovedImage(
  catalogItem: InternalMcpCatalog,
): Promise<void> {
  const installedServers = await McpServerModel.findByCatalogId(catalogItem.id);
  if (installedServers.length === 0) return;
  if (catalogItem.multitenant === true && catalogItem.serverType === "local") {
    await InternalMcpCatalogModel.update(catalogItem.id, {
      catalogReinstallRequired: true,
    });
    return;
  }
  autoReinstallInstallsInBackground(installedServers, catalogItem);
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
 * Non-prompted env entries land directly in the shared K8s pod's env on a
 * multi-tenant local catalog, so any change to one of them requires a pod
 * recreate. Prompted entries are per-install secrets surfaced at request
 * time — they don't live on the shared pod and are tracked separately by
 * `promptedEnvVarsChanged`, so we exclude them here. Compared fields are
 * `key + type + value` only;
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

/**
 * Resolve a catalog item that is subject to image approval — a local item with a
 * custom image — in the caller's org, or throw. The approve endpoint is
 * admin-gated by the route permission map; this adds the org-scope and "actually
 * gateable" guards.
 */
async function assertImageApprovable(
  id: string,
  organizationId: string,
): Promise<InternalMcpCatalog> {
  const catalogItem = await InternalMcpCatalogModel.findById(id, {
    expandSecrets: false,
  });
  if (!catalogItem || catalogItem.organizationId !== organizationId) {
    throw new ApiError(404, "Catalog item not found");
  }
  if (
    catalogItem.serverType !== "local" ||
    !catalogItem.localConfig?.dockerImage
  ) {
    throw new ApiError(
      400,
      "This catalog item is not subject to image approval.",
    );
  }
  return catalogItem;
}

export default internalMcpCatalogRoutes;
