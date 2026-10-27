// This file contains Enterprise regions licensed under LICENSE_ENTERPRISE.
import {
  ARCHESTRA_MCP_CATALOG_ID,
  AUTO_PROVISIONED_INVITATION_STATUS,
  CursorQuerySchema,
  createCursorPaginatedResponseSchema,
  getAgentRuntimeModelCompatibility,
  getArchestraMcpServerName,
  isModelSelectionComplete,
  providerHasEndpointLocalModels,
  providerRequiresPerUserCredential,
  RouteId,
} from "@archestra/shared";
import {
  INSTALLER_CLIENT_KEY_PROVIDERS,
  INSTALLER_CLIENT_LABELS,
  type InstallerClientId,
} from "@archestra/shared/connection-setup";
import { and, desc, eq, inArray, like, notExists, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { chatOpsManager } from "@/agents/chatops/chatops-manager";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { hasPermission } from "@/auth";
import { getPermissionsForUserContext, isGlobalAdmin } from "@/auth/utils";
import config from "@/config";
import db, { schema } from "@/database";
import { syncBuiltInSkillsForOrganization } from "@/database/seed";
import {
  enterpriseTier,
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  MCP_IDLE_HIBERNATION_ENTERPRISE_MESSAGE,
  // SPDX-SnippetEnd
} from "@/enterprise-tier";
import { daggerEnvironmentRuntimeManager } from "@/k8s/dagger-environment-runtime/manager";
import mcpServerRuntimeManager from "@/k8s/mcp-server-runtime/manager";
import logger from "@/logging";
import {
  AgentModel,
  InteractionModel,
  InternalMcpCatalogModel,
  KbConnectorDocumentCountModel,
  KbDocumentModel,
  KnowledgeBaseConnectorModel,
  LlmProviderApiKeyModel,
  LlmProviderApiKeyModelLinkModel,
  McpServerModel,
  McpToolCallModel,
  MemberModel,
  ModelModel,
  OrganizationModel,
  OrganizationRoleModel,
  SessionModel,
  ToolModel,
} from "@/models";
import { openappaBatteriesService } from "@/openappa/batteries";
import { reconcileCatalogDeployments } from "@/services/environments/deployment-reconciliation";
import { knowledgeSettingsService } from "@/services/knowledge-settings";
import { removeMemberTarget } from "@/services/member-removal";
import { reconcileManagedPlaywrightSetting } from "@/services/playwright-runtime";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  ApiError,
  AppearanceSettingsSchema,
  CompleteOnboardingSchema,
  type ConnectionClientProviderKeys,
  constructResponseSchema,
  KeywordRankingStatusSchema,
  type NetworkPolicy,
  type OrganizationRole,
  SelectOrganizationSchema,
  type TrustedImageRegistries,
  UpdateAgentSettingsSchema,
  UpdateAppearanceSettingsSchema,
  UpdateAuthSettingsSchema,
  UpdateConnectionSettingsSchema,
  UpdateDefaultEnvironmentSchema,
  UpdateIntegrationSettingsSchema,
  UpdateKnowledgeSettingsSchema,
  UpdateMcpSettingsSchema,
  UpdateSecuritySettingsSchema,
  UpdateSkillsSettingsSchema,
} from "@/types";
import { assertModelTrioTiers } from "@/utils/llm-resolution";

const organizationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/organization",
    {
      schema: {
        operationId: RouteId.GetOrganization,
        description: "Get organization details",
        tags: ["Organization"],
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId }, reply) => {
      const organization = await OrganizationModel.getById(organizationId);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/appearance-settings",
    {
      schema: {
        operationId: RouteId.UpdateAppearanceSettings,
        description: "Update appearance settings",
        tags: ["Organization"],
        body: UpdateAppearanceSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body, user }, reply) => {
      const currentOrganization =
        await OrganizationModel.getById(organizationId);
      if (!currentOrganization) {
        throw new ApiError(404, "Organization not found");
      }

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (
        config.enterpriseFeatures.fullWhiteLabeling &&
        body.appName !== undefined
      ) {
        // The built-in tools take their prefix from appName; one an MCP server
        // already gives its tools would route calls to either of them.
        const serverName = getArchestraMcpServerName({
          appName: body.appName,
          fullWhiteLabeling: true,
        });
        if (
          serverName !== archestraMcpBranding.serverName &&
          (await InternalMcpCatalogModel.findRootByNameInOrg({
            name: serverName,
            organizationId,
          }))
        )
          throw new ApiError(
            409,
            `An MCP server already gives its tools the "${serverName}" prefix this app name would give the built-in tools.`,
            "catalog_name_conflict",
          );
      }
      // SPDX-SnippetEnd

      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      if (
        config.enterpriseFeatures.fullWhiteLabeling &&
        (body.appName !== undefined || body.iconLogo !== undefined)
      ) {
        // appName renames the built-in tool/server names, and iconLogo updates
        // the built-in catalog metadata shown across the UI.
        const appNameChanged =
          currentOrganization.appName !== organization.appName;
        const iconChanged =
          currentOrganization.iconLogo !== organization.iconLogo;

        if (appNameChanged || iconChanged) {
          const renamedTools = await ToolModel.syncArchestraBuiltInCatalog({
            organization: organization,
          });
          // A saved policy's `archestra` alias spells the old prefix.
          if (renamedTools.length > 0)
            await openappaBatteriesService.onCatalogPrefixesRenamed({
              catalogId: ARCHESTRA_MCP_CATALOG_ID,
              // The built-in catalog is global: every organization spells it.
              organizationId: null,
              userId: user.id,
              renamedTools,
            });
        }

        // appName is baked into the built-in skills' stored rows (name, body,
        // tool-prefix references), so re-brand them now — without this the
        // catalog/load_skill output only updates after a backend restart. A
        // pristine copy auto-rebrands; an admin-edited copy is preserved.
        if (appNameChanged) {
          await syncBuiltInSkillsForOrganization(organization);
        }
      }
      // SPDX-SnippetEnd

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/security-settings",
    {
      schema: {
        operationId: RouteId.UpdateSecuritySettings,
        description:
          "Update security settings (default tool guardrails, chat file uploads)",
        tags: ["Organization"],
        body: UpdateSecuritySettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body, user }, reply) => {
      // Keep the existing permission gate for security settings; the browser
      // lifecycle control additionally requires a built-in administrator role.
      if (
        body.playwrightMcpEnabled !== undefined &&
        !(await isGlobalAdmin(user.id, organizationId))
      ) {
        throw new ApiError(
          403,
          "Only administrators can change the built-in browser setting",
        );
      }
      const organization =
        body.playwrightMcpEnabled !== undefined
          ? await reconcileManagedPlaywrightSetting({
              organizationId,
              settings: body,
            })
          : await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/mcp-settings",
    {
      schema: {
        operationId: RouteId.UpdateMcpSettings,
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        description:
          "Update MCP settings (online catalog availability, idle hibernation)",
        // SPDX-SnippetEnd
        tags: ["Organization"],
        body: UpdateMcpSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      // Scaling idle MCP servers to zero is enterprise-licensed. Refuse the
      // field outright rather than silently dropping it, so an unlicensed
      // deployment can't believe it turned the feature off either.
      if (
        "mcpIdleHibernationEnabled" in body &&
        !enterpriseTier.isCoreActive()
      ) {
        throw new ApiError(403, MCP_IDLE_HIBERNATION_ENTERPRISE_MESSAGE);
      }
      // Stamp before committing the toggle. Another replica may observe the
      // enabled setting immediately after that commit; every deployment must
      // already have a full idle window when its first sweep starts.
      if (body.mcpIdleHibernationEnabled === true) {
        await McpServerModel.grantIdleWindowToAll();
      }
      // SPDX-SnippetEnd

      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/skills-settings",
    {
      schema: {
        operationId: RouteId.UpdateSkillsSettings,
        description: "Update Skills settings (online catalog availability)",
        tags: ["Organization"],
        body: UpdateSkillsSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/agent-settings",
    {
      schema: {
        operationId: RouteId.UpdateAgentSettings,
        description:
          "Update agent settings (default model, default agent, skill slash commands)",
        tags: ["Organization"],
        body: UpdateAgentSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      // The default model and its API key are a pair: persist both or neither.
      const currentOrg =
        body.defaultModelId !== undefined ||
        body.defaultLlmApiKeyId !== undefined ||
        body.defaultFastModelId !== undefined ||
        body.defaultSmartModelId !== undefined
          ? await OrganizationModel.getById(organizationId)
          : null;
      const merged = {
        modelId:
          body.defaultModelId !== undefined
            ? body.defaultModelId
            : (currentOrg?.defaultModelId ?? null),
        apiKeyId:
          body.defaultLlmApiKeyId !== undefined
            ? body.defaultLlmApiKeyId
            : (currentOrg?.defaultLlmApiKeyId ?? null),
        fastModelId:
          body.defaultFastModelId !== undefined
            ? body.defaultFastModelId
            : (currentOrg?.defaultFastModelId ?? null),
        smartModelId:
          body.defaultSmartModelId !== undefined
            ? body.defaultSmartModelId
            : (currentOrg?.defaultSmartModelId ?? null),
      };

      // Validate the merged result only when this update touches either field.
      if (
        body.defaultModelId !== undefined ||
        body.defaultLlmApiKeyId !== undefined
      ) {
        if (
          !isModelSelectionComplete({
            modelId: merged.modelId,
            apiKeyId: merged.apiKeyId,
          })
        ) {
          throw new ApiError(
            400,
            "The default model and API key must be set together",
          );
        }
        await assertOrganizationDefaultModelSelection({
          organizationId,
          modelId: merged.modelId,
          apiKeyId: merged.apiKeyId,
        });
        await assertRuntimeAgentsSupportOrganizationDefault({
          organizationId,
          modelId: merged.modelId,
        });
      }

      if (
        body.defaultLlmApiKeyId !== undefined ||
        body.defaultFastModelId !== undefined ||
        body.defaultSmartModelId !== undefined
      ) {
        await assertModelTrioTiers(merged);
      }

      if (body.defaultAgentId) {
        const agent = await AgentModel.findById(body.defaultAgentId);
        if (!agent || agent.organizationId !== organizationId) {
          throw new ApiError(404, "Agent not found");
        }
      }

      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/connection-settings",
    {
      schema: {
        operationId: RouteId.UpdateConnectionSettings,
        description:
          "Update /connection admin settings (default gateway, hidden clients, skills/LLM proxy availability)",
        tags: ["Organization"],
        body: UpdateConnectionSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      if (body.connectionDefaultMcpGatewayId) {
        const agent = await AgentModel.findById(
          body.connectionDefaultMcpGatewayId,
        );
        if (!agent || agent.organizationId !== organizationId) {
          throw new ApiError(404, "MCP gateway not found");
        }
        if (
          agent.agentType !== "mcp_gateway" &&
          agent.agentType !== "profile"
        ) {
          throw new ApiError(400, "Agent is not an MCP gateway");
        }
        // One member's personal gateway is no default for everyone. A value
        // saved before this rule may be resubmitted unchanged.
        if (agent.isPersonalGateway) {
          const current = await OrganizationModel.getById(organizationId);
          if (current?.connectionDefaultMcpGatewayId !== agent.id) {
            throw new ApiError(
              400,
              "A personal MCP gateway cannot be the default",
            );
          }
        }
      }

      if (body.connectionClientProviderKeys) {
        await validateConnectionClientProviderKeys({
          organizationId,
          mapping: body.connectionClientProviderKeys,
        });
      }

      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/integration-settings",
    {
      schema: {
        operationId: RouteId.UpdateIntegrationSettings,
        description:
          "Customize the built-in integration catalogs: hide model providers, messaging channels, knowledge connectors, or coding agent templates, order coding agent templates, and override model provider labels. Omitted catalogs are left unchanged; null clears a catalog's overrides.",
        tags: ["Organization"],
        body: UpdateIntegrationSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      // Hiding a messaging channel has to actually stop it: a Slack or Teams
      // bot left listening would keep answering after the admin switched the
      // channel off. The manager re-reads the overrides on initialize.
      if (body.messagingChannelOverrides !== undefined) {
        await chatOpsManager.reinitialize();
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/default-environment",
    {
      schema: {
        operationId: RouteId.UpdateDefaultEnvironment,
        description:
          "Configure the implicit default environment (the deployment target referenced by internal_mcp_catalog.environment_id = null). Pass null for name to reset to the built-in 'Default' label, or null for namespace to unset it. Omitted fields are left unchanged. When the namespace or network policy changes and the runtime is enabled, all default-environment MCP servers are reconciled.",
        tags: ["Organization"],
        body: UpdateDefaultEnvironmentSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const namespaceChanging = "namespace" in body;
      const networkPolicyChanging = "networkPolicy" in body;

      // Validate that the new namespace actually exists in the cluster before
      // touching the DB — mirrors the environment PATCH route, avoiding a
      // state where the DB names a namespace pods can never start in.
      if (
        namespaceChanging &&
        body.namespace != null &&
        mcpServerRuntimeManager.isEnabled
      ) {
        try {
          await mcpServerRuntimeManager.validateNamespace(body.namespace);
        } catch (err) {
          throw new ApiError(
            400,
            err instanceof Error ? err.message : "Namespace validation failed",
          );
        }
      }

      const currentOrganization =
        namespaceChanging || networkPolicyChanging
          ? await OrganizationModel.getById(organizationId)
          : null;
      const namespaceActuallyChanging =
        namespaceChanging &&
        currentOrganization !== null &&
        (body.namespace ?? null) !==
          (currentOrganization?.defaultEnvironmentNamespace ?? null);
      const networkPolicyActuallyChanging =
        networkPolicyChanging &&
        currentOrganization !== null &&
        !sameNetworkPolicy(
          body.networkPolicy ?? null,
          currentOrganization?.defaultNetworkPolicy ?? null,
        );

      // Pre-load deployments while the OLD namespace is still in the DB, so
      // the in-memory K8sDeployment objects point at the old namespace and
      // the restart's teardown targets the right place (mirrors the
      // environment PATCH route).
      let catalogsToReconcile: { id: string; multitenant: boolean }[] = [];
      if (namespaceActuallyChanging && mcpServerRuntimeManager.isEnabled) {
        catalogsToReconcile =
          await InternalMcpCatalogModel.findDefaultEnvironmentLocalCatalogs(
            organizationId,
          );
        const servers = await McpServerModel.findByCatalogIds(
          catalogsToReconcile.map((catalog) => catalog.id),
        );
        await Promise.all(
          servers.map((server) =>
            mcpServerRuntimeManager.getOrLoadDeployment(server.id),
          ),
        );
      }

      // Map the clean API shape to DB columns, including only keys that are
      // present in the body so omitting a field leaves it unchanged (an
      // explicit null clears the column).
      const data: Partial<{
        defaultEnvironmentName: string | null;
        defaultEnvironmentDescription: string | null;
        defaultEnvironmentNamespace: string | null;
        defaultNetworkPolicy: typeof body.networkPolicy;
        defaultEnvironmentValidationRegex: string | null;
        defaultEnvironmentTrustedImageRegistries: TrustedImageRegistries | null;
      }> = {};
      if ("name" in body) {
        data.defaultEnvironmentName = body.name ?? null;
      }
      if ("description" in body) {
        data.defaultEnvironmentDescription = body.description ?? null;
      }
      if ("namespace" in body) {
        data.defaultEnvironmentNamespace = body.namespace ?? null;
      }
      if ("networkPolicy" in body) {
        data.defaultNetworkPolicy = body.networkPolicy ?? null;
      }
      if ("validationRegex" in body) {
        data.defaultEnvironmentValidationRegex = body.validationRegex ?? null;
      }
      if ("trustedImageRegistries" in body) {
        data.defaultEnvironmentTrustedImageRegistries =
          body.trustedImageRegistries ?? null;
      }

      const organization = await OrganizationModel.patch(organizationId, data);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      if (
        (namespaceActuallyChanging || networkPolicyActuallyChanging) &&
        mcpServerRuntimeManager.isEnabled
      ) {
        const catalogs =
          catalogsToReconcile.length > 0
            ? catalogsToReconcile
            : await InternalMcpCatalogModel.findDefaultEnvironmentLocalCatalogs(
                organizationId,
              );
        await reconcileCatalogDeployments({
          catalogs,
          reason: namespaceActuallyChanging
            ? "default environment namespace change"
            : "default environment network policy change",
        });
      }

      // The default engine carries the org's default egress policy and lives in
      // the org's default namespace, so re-provision it when either changes.
      // Awaited (like the MCP reconcile above) so the response reflects the
      // applied egress policy rather than returning 200 while the engine still
      // runs the old, looser policy; the manager no-ops when code-runtime/k8s is
      // off. Runs after the DB patch, so a failure surfaces a retryable error.
      if ("networkPolicy" in body || "namespace" in body) {
        await daggerEnvironmentRuntimeManager.reconcileOrganizationDefault(
          organization,
        );
      }

      // A namespace change provisions the engine in the new namespace above but
      // leaves the old one running with its retained cache PVC; tear it down.
      // currentOrganization holds the pre-patch namespace (loaded before the
      // patch when the namespace was changing).
      if (namespaceActuallyChanging) {
        await daggerEnvironmentRuntimeManager.teardownOrganizationDefaultEngine(
          organization,
          currentOrganization?.defaultEnvironmentNamespace ?? null,
        );
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/auth-settings",
    {
      schema: {
        operationId: RouteId.UpdateAuthSettings,
        description: "Update organization Auth settings",
        tags: ["Organization"],
        body: UpdateAuthSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body, user, headers, serviceAccount }, reply) => {
      // The default role is stamped onto every account provisioned without an
      // explicit role (self-signup, ChatOps auto-provisioning, role-less
      // invitation acceptance), so choosing it is member administration rather
      // than a general organization setting. Gate it on member:create so the
      // broader organizationSettings:update — which roles like editor hold to
      // manage appearance and auth options — is not by itself enough to decide
      // what new accounts are granted.
      if ("defaultMemberRole" in body) {
        const { success: canProvisionMembers } = await hasPermission(
          { member: ["create"] },
          headers,
          serviceAccount,
          { userId: user.id, organizationId },
        );
        if (!canProvisionMembers) {
          throw new ApiError(
            403,
            "You are not authorized to change the default role for new members",
          );
        }
      }

      // A non-null default role must resolve to a real role in this org
      // (predefined or custom) — otherwise new members would be provisioned
      // with a role that grants no permissions.
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      for (const roleIdentifier of body.defaultMemberRole?.split(",") ?? []) {
        const role = await OrganizationRoleModel.getByIdentifier(
          roleIdentifier,
          organizationId,
        );
        if (!role) {
          throw new ApiError(400, "Default role not found");
        }

        // Existence alone is not enough: predefined roles resolve here too, so
        // without this the field could name a role more privileged than the
        // caller and have future accounts provisioned into it. Hold the caller
        // to the same "only grant what you have" rule custom-role authoring
        // uses.
        await assertCallerCanGrantRole({
          role,
          userId: user.id,
          organizationId,
        });
      }
      // SPDX-SnippetEnd

      // Requiring 2FA is enterprise-licensed enforcement (see enterprise-tier
      // for the small-team allowance). Session caps ride the same gate.
      if (
        (body.requireTwoFactor === true ||
          typeof body.sessionMaxAgeSeconds === "number") &&
        !enterpriseTier.isCoreActive()
      ) {
        throw new ApiError(
          403,
          "Requiring two-factor authentication and session lifetime caps " +
            "are enterprise features. Please contact sales@archestra.ai to " +
            "enable them.",
        );
      }

      // Enrolling in 2FA requires confirming a password (better-auth's
      // /two-factor/enable mandates it), so on a password-less deployment the
      // requirement would lock every member out with no way to satisfy it.
      // SSO deployments enforce MFA at the identity provider instead.
      if (body.requireTwoFactor === true && config.auth.disableBasicAuth) {
        throw new ApiError(
          400,
          "Two-factor authentication cannot be required while email/password " +
            "sign-in is disabled: enrolling requires confirming a password. " +
            "Enforce multi-factor authentication at your identity provider " +
            "instead.",
        );
      }

      const before = await OrganizationModel.getById(organizationId);
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      // Flipping require-2FA ON revokes every session belonging to a member
      // who has not enrolled — their next sign-in lands in mandatory setup.
      // Enrolled members keep their sessions. (The signed session cookie
      // cache means revocation can lag by up to its 60s TTL.)
      if (body.requireTwoFactor === true && !before?.requireTwoFactor) {
        const revoked =
          await SessionModel.deleteAllForOrganizationMembersWithoutTwoFactor(
            organizationId,
          );
        logger.info(
          { organizationId, revoked },
          "require-2FA enabled — revoked sessions of non-enrolled members",
        );
      }

      return reply.send(organization);
    },
  );

  fastify.patch(
    "/api/organization/knowledge-settings",
    {
      schema: {
        operationId: RouteId.UpdateKnowledgeSettings,
        description: "Update knowledge settings (embedding model)",
        tags: ["Organization"],
        body: UpdateKnowledgeSettingsSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const currentOrg = await OrganizationModel.getById(organizationId);

      // Effective (post-save) embedding + reranker pairs. Distinguish "not
      // changing" (undefined) from "clearing" (null) so a cleared field is seen
      // as cleared, not masked back to its current value.
      const effectiveEmbeddingKeyId =
        body.embeddingChatApiKeyId !== undefined
          ? body.embeddingChatApiKeyId
          : (currentOrg?.embeddingChatApiKeyId ?? null);
      const effectiveEmbeddingModel =
        body.embeddingModel !== undefined
          ? body.embeddingModel
          : (currentOrg?.embeddingModel ?? null);
      const effectiveRerankerKeyId =
        body.rerankerChatApiKeyId !== undefined
          ? body.rerankerChatApiKeyId
          : (currentOrg?.rerankerChatApiKeyId ?? null);
      const effectiveRerankerModel =
        body.rerankerModel !== undefined
          ? body.rerankerModel
          : (currentOrg?.rerankerModel ?? null);
      const effectiveOcrKeyId =
        body.ocrChatApiKeyId !== undefined
          ? body.ocrChatApiKeyId
          : (currentOrg?.ocrChatApiKeyId ?? null);
      const effectiveOcrModel =
        body.ocrModel !== undefined
          ? body.ocrModel
          : (currentOrg?.ocrModel ?? null);

      // Embedding is locked once fully configured: changing OR clearing it (any
      // difference from the current pair, incl. a null clear) must go through the
      // drop-embedding route, which also deletes the now-stale vectors and resets
      // connector checkpoints.
      const isEmbeddingConfigLocked =
        !!currentOrg?.embeddingChatApiKeyId && !!currentOrg?.embeddingModel;
      if (
        isEmbeddingConfigLocked &&
        (effectiveEmbeddingKeyId !== currentOrg?.embeddingChatApiKeyId ||
          effectiveEmbeddingModel !== currentOrg?.embeddingModel)
      ) {
        throw new ApiError(
          400,
          "Embedding configuration cannot be changed once set. Drop the existing configuration to reconfigure — all documents will need to be re-embedded.",
          "embedding_validation_failed",
        );
      }

      // Only validate the embedding/reranker pairs when the patch actually
      // touches them: a patch to an unrelated knowledge setting (e.g.
      // permissionSyncSchedule) must not be blocked by — or fire a live probe
      // for — pre-existing embedding state it doesn't change.
      const patchTouchesEmbedding =
        body.embeddingChatApiKeyId !== undefined ||
        body.embeddingModel !== undefined;
      const patchTouchesReranker =
        body.rerankerChatApiKeyId !== undefined ||
        body.rerankerModel !== undefined;
      const patchTouchesOcr =
        body.ocrChatApiKeyId !== undefined || body.ocrModel !== undefined;

      // Embedding is mandatory: a half-configured pair (a key with no model, or a
      // model with no key) is invalid and blocks save. To clear the embedding
      // entirely, use the drop-embedding route.
      if (
        patchTouchesEmbedding &&
        Boolean(effectiveEmbeddingKeyId) !== Boolean(effectiveEmbeddingModel)
      ) {
        throw new ApiError(
          400,
          "Both an embedding API key and model are required. To clear the embedding configuration, use Drop.",
          "embedding_validation_failed",
        );
      }

      // Validate BOTH configurations by actually exercising them (a real embedding
      // call, a real structured-output reranker call) — not just checking fields
      // are filled. Embedding is validated when set; the reranker is optional but
      // must be valid when set, and a half-configured reranker blocks save. The
      // failing field is carried in the ApiError's internal_code so the UI can
      // show it per-field.
      if (
        patchTouchesEmbedding &&
        effectiveEmbeddingKeyId &&
        effectiveEmbeddingModel
      ) {
        const result = await knowledgeSettingsService.validateEmbeddingConfig({
          keyId: effectiveEmbeddingKeyId,
          model: effectiveEmbeddingModel,
          organizationId,
        });
        if (!result.ok) {
          throw new ApiError(
            400,
            result.error ?? "Embedding validation failed.",
            "embedding_validation_failed",
          );
        }
      }

      if (
        patchTouchesReranker &&
        Boolean(effectiveRerankerKeyId) !== Boolean(effectiveRerankerModel)
      ) {
        throw new ApiError(
          400,
          "Both a reranker API key and model are required, or clear both.",
          "reranker_validation_failed",
        );
      }
      if (
        patchTouchesReranker &&
        effectiveRerankerKeyId &&
        effectiveRerankerModel
      ) {
        const result = await knowledgeSettingsService.validateRerankerConfig({
          keyId: effectiveRerankerKeyId,
          model: effectiveRerankerModel,
          organizationId,
        });
        if (!result.ok) {
          throw new ApiError(
            400,
            result.error ?? "Reranker validation failed.",
            "reranker_validation_failed",
          );
        }
      }

      if (
        patchTouchesOcr &&
        Boolean(effectiveOcrKeyId) !== Boolean(effectiveOcrModel)
      ) {
        throw new ApiError(
          400,
          "Both an OCR API key and model are required, or clear both.",
          "ocr_validation_failed",
        );
      }
      if (patchTouchesOcr && effectiveOcrKeyId && effectiveOcrModel) {
        const result = await knowledgeSettingsService.validateOcrConfig({
          keyId: effectiveOcrKeyId,
          model: effectiveOcrModel,
          organizationId,
        });
        if (!result.ok) {
          throw new ApiError(
            400,
            result.error ?? "OCR validation failed.",
            "ocr_validation_failed",
          );
        }
      }

      // Turning OCR on (unset -> configured) resets connector checkpoints so
      // the next sync re-presents documents that were previously skipped as
      // having no extractable text — a delta sync would otherwise never show
      // them again and enabling OCR would appear to do nothing. Key/model
      // swaps and clears deliberately do not trigger this. The reset runs
      // BEFORE the organization write: resetting is idempotent and benign on
      // its own, while the reverse order could persist an enabled OCR whose
      // reset failed — and a retry would then see OCR as "already configured"
      // and never reset at all.
      const ocrWasConfigured =
        !!currentOrg?.ocrChatApiKeyId && !!currentOrg?.ocrModel;
      const ocrBecomesConfigured =
        patchTouchesOcr &&
        !ocrWasConfigured &&
        !!effectiveOcrKeyId &&
        !!effectiveOcrModel;
      if (ocrBecomesConfigured) {
        await KnowledgeBaseConnectorModel.resetCheckpointsByOrganization(
          organizationId,
        );
        logger.info(
          { organizationId },
          "OCR enabled — connector checkpoints reset for a full re-sync",
        );
      }

      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.post(
    "/api/organization/knowledge-settings/drop-embedding",
    {
      schema: {
        operationId: RouteId.DropEmbeddingConfig,
        description:
          "Drop the embedding configuration, deleting all KB documents and resetting connector checkpoints",
        tags: ["Organization"],
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId }, reply) => {
      const currentOrg = await OrganizationModel.getById(organizationId);
      if (!currentOrg?.embeddingChatApiKeyId || !currentOrg?.embeddingModel) {
        throw new ApiError(
          400,
          "Embedding configuration is not locked — nothing to drop",
        );
      }

      // Delete all KB documents (chunks cascade via FK)
      await KbDocumentModel.deleteByOrganization(organizationId);
      await KbConnectorDocumentCountModel.refreshForOrganization({
        organizationId,
      });

      // Reset connector checkpoints so next sync does a full re-ingest
      await KnowledgeBaseConnectorModel.resetCheckpointsByOrganization(
        organizationId,
      );

      // Clear embedding config
      const organization = await OrganizationModel.patch(organizationId, {
        embeddingModel: null,
        embeddingChatApiKeyId: null,
      });

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.post(
    "/api/organization/knowledge-settings/test-embedding",
    {
      schema: {
        operationId: RouteId.TestEmbeddingConnection,
        description: "Test the embedding connection by embedding a sample text",
        tags: ["Organization"],
        body: z.object({
          embeddingChatApiKeyId: z.string().uuid(),
          embeddingModel: z.string().min(1),
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ body, organizationId }, reply) => {
      const result = await knowledgeSettingsService.validateEmbeddingConfig({
        keyId: body.embeddingChatApiKeyId,
        model: body.embeddingModel,
        organizationId,
      });
      return reply.send({
        success: result.ok,
        ...(result.error ? { error: result.error } : {}),
      });
    },
  );

  fastify.post(
    "/api/organization/knowledge-settings/test-reranker",
    {
      schema: {
        operationId: RouteId.TestRerankerConnection,
        description:
          "Test the reranker connection with a sample structured-output call",
        tags: ["Organization"],
        body: z.object({
          rerankerChatApiKeyId: z.string().uuid(),
          rerankerModel: z.string().min(1),
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ body, organizationId }, reply) => {
      const result = await knowledgeSettingsService.validateRerankerConfig({
        keyId: body.rerankerChatApiKeyId,
        model: body.rerankerModel,
        organizationId,
      });
      return reply.send({
        success: result.ok,
        ...(result.error ? { error: result.error } : {}),
      });
    },
  );

  fastify.get(
    "/api/organization/knowledge-settings/keyword-ranking-status",
    {
      schema: {
        operationId: RouteId.GetKeywordRankingStatus,
        description:
          "Where BM25 keyword ranking stands for the organization: whether " +
          "its corpus statistics cover every language with indexed " +
          "documents (until they do, keyword search ranks that language " +
          "with PostgreSQL's built-in ts_rank), when they were last rebuilt " +
          "and when the next rebuild is due",
        tags: ["Organization"],
        response: constructResponseSchema(KeywordRankingStatusSchema),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(
        await knowledgeSettingsService.getKeywordRankingStatus(organizationId),
      );
    },
  );

  fastify.post(
    "/api/organization/knowledge-settings/test-ocr",
    {
      schema: {
        operationId: RouteId.TestOcrConnection,
        description:
          "Test the OCR configuration by sending a synthetic PDF page to the model",
        tags: ["Organization"],
        body: z.object({
          ocrChatApiKeyId: z.string().uuid(),
          ocrModel: z.string().min(1),
        }),
        response: constructResponseSchema(
          z.object({
            success: z.boolean(),
            error: z.string().optional(),
          }),
        ),
      },
    },
    async ({ body, organizationId }, reply) => {
      const result = await knowledgeSettingsService.validateOcrConfig({
        keyId: body.ocrChatApiKeyId,
        model: body.ocrModel,
        organizationId,
      });
      return reply.send({
        success: result.ok,
        ...(result.error ? { error: result.error } : {}),
      });
    },
  );

  fastify.post(
    "/api/organization/complete-onboarding",
    {
      schema: {
        operationId: RouteId.CompleteOnboarding,
        description: "Mark organization onboarding as complete",
        tags: ["Organization"],
        body: CompleteOnboardingSchema,
        response: constructResponseSchema(SelectOrganizationSchema),
      },
    },
    async ({ organizationId, body }, reply) => {
      const organization = await OrganizationModel.patch(organizationId, body);

      if (!organization) {
        throw new ApiError(404, "Organization not found");
      }

      return reply.send(organization);
    },
  );

  fastify.get(
    "/api/organization/onboarding-status",
    {
      schema: {
        operationId: RouteId.GetOnboardingStatus,
        description: "Check if organization onboarding is complete",
        tags: ["Organization"],
        response: constructResponseSchema(
          z.object({
            hasLlmProxyLogs: z.boolean(),
            hasMcpGatewayLogs: z.boolean(),
          }),
        ),
      },
    },
    async (_request, reply) => {
      // Check if onboarding is complete by checking if there are any logs
      const interactionCount = await InteractionModel.getCount();
      const mcpToolCallCount = await McpToolCallModel.getCount();

      return reply.send({
        hasLlmProxyLogs: interactionCount > 0,
        hasMcpGatewayLogs: mcpToolCallCount > 0,
      });
    },
  );

  /**
   * Get signup status for organization members.
   * Returns members that don't have an account record (auto-provisioned, haven't signed up),
   * along with the provider they were auto-provisioned from.
   */
  fastify.get(
    "/api/organization/members/signup-status",
    {
      schema: {
        operationId: RouteId.GetMemberSignupStatus,
        description:
          "Get which members have not completed signup (no account record). Pass `userIds` to ask about the members on screen instead of every member.",
        tags: ["Organization"],
        querystring: z.object({
          userIds: z
            .preprocess(
              (value) => (typeof value === "string" ? value.split(",") : value),
              z.array(z.string()).max(100),
            )
            .optional()
            .describe(
              "Only these members (comma-separated user IDs), such as the rows of one Users page. Without it, every member of the organization is checked.",
            ),
        }),
        response: constructResponseSchema(
          z.object({
            pendingSignupMembers: z.array(
              z.object({
                userId: z.string(),
                name: z.string().nullable(),
                email: z.string(),
                image: z.string().nullable(),
                role: z.string(),
                provider: z.string().nullable(),
                invitationId: z.string().nullable(),
              }),
            ),
          }),
        ),
      },
    },
    async ({ organizationId, query }, reply) => {
      if (query.userIds && query.userIds.length === 0) {
        return reply.send({ pendingSignupMembers: [] });
      }

      const members = schema.membersTable;
      const users = schema.usersTable;
      const invitations = schema.invitationsTable;

      // The newest auto-provisioned invitation for the member's email, if
      // any: its status carries the provider ("auto-provisioned:<provider>")
      // and its id builds the sign-up link.
      const invitation = db
        .select({ id: invitations.id, status: invitations.status })
        .from(invitations)
        .where(
          and(
            eq(invitations.organizationId, members.organizationId),
            eq(invitations.email, users.email),
            like(invitations.status, `${AUTO_PROVISIONED_INVITATION_STATUS}%`),
          ),
        )
        .orderBy(desc(invitations.createdAt))
        .limit(1)
        .as("auto_provisioned_invitation");

      // One statement: the members (of one page, when `userIds` is given)
      // that have no account row yet, each with its invitation. This used to
      // read every member id, every account of those members and every
      // auto-provisioned invitation, then send every pending member of the
      // organization on each Users page load.
      const rows = await db
        .select({
          userId: members.userId,
          name: users.name,
          email: users.email,
          image: users.image,
          role: members.role,
          invitationId: invitation.id,
          invitationStatus: invitation.status,
        })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .leftJoinLateral(invitation, sql`true`)
        .where(
          and(
            eq(members.organizationId, organizationId),
            notExists(
              db
                .select({ one: sql`1` })
                .from(schema.accountsTable)
                .where(eq(schema.accountsTable.userId, members.userId)),
            ),
            query.userIds ? inArray(members.userId, query.userIds) : undefined,
          ),
        );

      const pendingSignupMembers = rows.map((row) => {
        const parts = row.invitationStatus?.split(":") ?? [];
        return {
          userId: row.userId,
          name: row.name,
          email: row.email,
          image: row.image,
          role: row.role,
          provider: parts.length === 2 ? parts[1] : null,
          invitationId: row.invitationId ?? null,
        };
      });

      return reply.send({ pendingSignupMembers });
    },
  );

  /**
   * Delete an auto-provisioned member who hasn't completed signup.
   * Removes the member, invitation, user token, and user record.
   */
  fastify.delete(
    "/api/organization/members/:userId/pending-signup",
    {
      schema: {
        operationId: RouteId.DeletePendingSignupMember,
        description:
          "Delete an auto-provisioned member who hasn't completed signup",
        tags: ["Organization"],
        params: z.object({ userId: z.string() }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ organizationId, params, user }, reply) => {
      const result = await removeMemberTarget({
        organizationId,
        actorUserId: user.id,
        target: { kind: "pendingSignup", id: params.userId },
      });

      if (result.status === "classification_changed") {
        throw new ApiError(
          400,
          "Cannot delete a member who has already completed signup",
        );
      }
      if (result.status === "self") {
        throw new ApiError(400, "You cannot remove your own account");
      }
      if (result.status === "not_found") {
        throw new ApiError(404, "User not found");
      }
      await openappaBatteriesService.recompileOrganizations([organizationId]);

      return reply.send({ success: true });
    },
  );

  fastify.get(
    "/api/organization/member-options",
    {
      schema: {
        operationId: RouteId.GetOrganizationMemberOptions,
        description:
          "Search visible organization member identities in bounded pages. The same directory visibility applies: member:read sees all members; other authenticated callers see only teammates.",
        tags: ["Organization"],
        querystring: CursorQuerySchema.extend({
          search: z.string().optional(),
          searchMode: z
            .enum(["name", "name_or_email"])
            .default("name_or_email"),
          ids: z
            .preprocess(
              (value) => (typeof value === "string" ? value.split(",") : value),
              z.array(z.string().min(1)).max(100),
            )
            .optional(),
          emails: z
            .preprocess(
              (value) => (typeof value === "string" ? value.split(",") : value),
              z.array(z.string().min(1)).max(100),
            )
            .optional(),
        }),
        response: constructResponseSchema(
          createCursorPaginatedResponseSchema(
            z.object({ id: z.string(), name: z.string(), email: z.string() }),
          ),
        ),
      },
    },
    async ({ organizationId, user, headers, serviceAccount, query }, reply) => {
      const { success: canSeeAllMembers } = await hasPermission(
        { member: ["read"] },
        headers,
        serviceAccount,
        { userId: user.id, organizationId },
      );
      return reply.send(
        await MemberModel.findOptions({
          organizationId,
          viewerId: user.id,
          canSeeAllMembers,
          pagination: { limit: query.limit, cursor: query.cursor },
          search: query.search,
          searchMode: query.searchMode,
          ids: query.ids,
          emails: query.emails,
        }),
      );
    },
  );

  fastify.get(
    "/api/organization/members/:idOrEmail",
    {
      schema: {
        operationId: RouteId.GetOrganizationMember,
        description:
          "Get a member of the organization by user ID or email address",
        tags: ["Organization"],
        params: z.object({
          idOrEmail: z.string().min(1).describe("User ID or email address"),
        }),
        response: constructResponseSchema(
          z.object({
            id: z.string(),
            name: z.string(),
            email: z.string(),
            role: z.string(),
          }),
        ),
      },
    },
    async ({ organizationId, params: { idOrEmail } }, reply) => {
      const member = await MemberModel.findByIdOrEmail(
        idOrEmail,
        organizationId,
      );
      if (!member) {
        throw new ApiError(404, "Member not found");
      }
      return reply.send(member);
    },
  );

  fastify.get(
    "/api/organization/appearance-settings",
    {
      schema: {
        operationId: RouteId.GetAppearanceSettings,
        description: "Get organization appearance settings",
        tags: ["Organization"],
        response: constructResponseSchema(AppearanceSettingsSchema),
      },
    },
    async (_request, reply) => {
      return reply.send(await OrganizationModel.getAppearanceSettings());
    },
  );
};

async function assertOrganizationDefaultModelSelection(params: {
  organizationId: string;
  modelId: string | null;
  apiKeyId: string | null;
}): Promise<void> {
  if (!params.modelId && !params.apiKeyId) return;
  if (!params.modelId || !params.apiKeyId) {
    throw new ApiError(
      400,
      "The default model and API key must be set together",
    );
  }
  const apiKey = await LlmProviderApiKeyModel.findById(params.apiKeyId);
  if (!apiKey || apiKey.organizationId !== params.organizationId) {
    throw new ApiError(404, "API key not found");
  }
  const modelIsLinked = (
    await LlmProviderApiKeyModelLinkModel.getModelsForApiKeyIds([apiKey.id])
  ).some(({ model }) => model.id === params.modelId);
  if (!modelIsLinked) {
    throw new ApiError(400, "The default model and API key must be linked");
  }
}

async function assertRuntimeAgentsSupportOrganizationDefault(params: {
  organizationId: string;
  modelId: string | null;
}): Promise<void> {
  if (!params.modelId) return;
  const [model, agents] = await Promise.all([
    ModelModel.findById(params.modelId),
    AgentModel.findRuntimeAgentsInheritingOrganizationDefault(
      params.organizationId,
    ),
  ]);
  if (!model) {
    throw new ApiError(404, "Default model not found");
  }
  const incompatible = agents.find((agent) => {
    if (!agent.runtime) return false;
    return !getAgentRuntimeModelCompatibility({
      inferenceProtocol: agent.runtime.inferenceProtocol,
      runtimeCommand: agent.runtime.command,
      provider: model.provider,
      modelId: model.modelId,
      supportedEndpoints: model.supportedEndpoints,
    }).compatible;
  });
  if (incompatible) {
    throw new ApiError(
      409,
      `The proposed default model is incompatible with Agent Runtime Agent "${incompatible.name}". Update that Agent's runtime or choose a compatible default model.`,
    );
  }
}

export default organizationRoutes;

// === Internal helpers ===

/**
 * Every mapped key must belong to the organization, match its provider, and
 * be a provider the client can route — one key per provider, except where a
 * provider's keys are separate endpoints. Per-user providers (GitHub Copilot)
 * can't be mapped: each user connects their own account at setup time, and
 * the connection flow refuses to wrap someone else's personal key.
 */
async function validateConnectionClientProviderKeys(params: {
  organizationId: string;
  mapping: ConnectionClientProviderKeys;
}) {
  const entries = Object.entries(params.mapping).flatMap(([clientId, keys]) =>
    (keys ?? []).map((key) => ({
      ...key,
      clientId: clientId as InstallerClientId,
    })),
  );
  const keys = await LlmProviderApiKeyModel.findByIds([
    ...new Set(entries.map((entry) => entry.providerApiKeyId)),
  ]);
  const keysById = new Map(keys.map((key) => [key.id, key]));
  const seen = new Set<string>();
  for (const { clientId, provider, providerApiKeyId } of entries) {
    const key = keysById.get(providerApiKeyId);
    if (!key || key.organizationId !== params.organizationId) {
      throw new ApiError(404, "Provider API key not found");
    }
    if (key.provider !== provider) {
      throw new ApiError(
        400,
        `Key "${key.name}" is for provider "${key.provider}", not "${provider}"`,
      );
    }
    if (providerRequiresPerUserCredential(provider)) {
      throw new ApiError(
        400,
        `${provider} is per-user — each user connects their own account, so it can't be mapped to a setup command's virtual key.`,
      );
    }
    if (!INSTALLER_CLIENT_KEY_PROVIDERS[clientId].includes(provider)) {
      throw new ApiError(
        400,
        `${INSTALLER_CLIENT_LABELS[clientId]} can't route ${provider} requests.`,
      );
    }
    const slot = `${clientId}:${provider}`;
    if (seen.has(slot) && !providerHasEndpointLocalModels(provider)) {
      throw new ApiError(
        400,
        `${INSTALLER_CLIENT_LABELS[clientId]} can map only one ${provider} key.`,
      );
    }
    seen.add(slot);
  }
}

async function assertCallerCanGrantRole(params: {
  role: OrganizationRole;
  userId: string;
  organizationId: string;
}) {
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  await ResourcePermissions.validateSubjectAssignment({
    organizationId: params.organizationId,
    userId: params.userId,
    subjects: [{ type: "role", id: params.role.id }],
  });
  // SPDX-SnippetEnd
  const callerPermissions = await getPermissionsForUserContext({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  const { valid, missingPermissions } =
    OrganizationRoleModel.validateRolePermissions(
      callerPermissions,
      params.role.permission,
    );
  if (!valid) {
    throw new ApiError(
      403,
      `You cannot grant permissions you don't have: ${missingPermissions.join(", ")}`,
    );
  }
}

function sameNetworkPolicy(
  a: NetworkPolicy | null,
  b: NetworkPolicy | null,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
