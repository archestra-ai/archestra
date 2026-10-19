import {
  ManagedResourceSchema,
  PermissionsSchema,
  ResourcePermissionActionSchema,
  ResourcePermissionScopeSchema,
  RouteId,
  withoutWildcardCoveredGrants,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { AgentModel, MemberModel, OrganizationModel } from "@/models";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ResourcePermissions } from "@/services/resource-permissions";
// SPDX-SnippetEnd
import { getUserPermissions } from "@/services/user";
import {
  AppearanceSettingsSchema,
  constructResponseSchema,
  SelectOrganizationSchema,
} from "@/types";
import {
  ConfigResponseSchema,
  getConfigResponse,
  getPublicConfigResponse,
  PublicConfigResponseSchema,
} from "./config";

/**
 * The reads the app shell needs before it can draw a page, in one round trip.
 * The frontend fires this alongside the session check on a cold load and
 * seeds each part into the query its own endpoint feeds, so the shell skips a
 * second wave of requests. Each part is exactly what its own endpoint returns
 * (`/api/user/permissions`, `/api/resource-permissions`, `/api/organization`,
 * `/api/config`, `/api/config/public`, `/api/organization/appearance-settings`,
 * `/api/members/default-agent`, `/api/members/default-model`).
 */
const bootstrapRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/bootstrap",
    {
      schema: {
        operationId: RouteId.GetBootstrap,
        description:
          "Get the signed-in user's permissions, organization, platform config, appearance settings, and chat defaults in one request",
        tags: ["Config"],
        response: constructResponseSchema(
          z.object({
            permissions: PermissionsSchema,
            scopedCapabilities: z.array(
              z.object({
                organizationId: z.string(),
                resource: ManagedResourceSchema,
                scope: ResourcePermissionScopeSchema,
                action: ResourcePermissionActionSchema,
              }),
            ),
            organization: SelectOrganizationSchema.nullable(),
            config: ConfigResponseSchema,
            publicConfig: PublicConfigResponseSchema,
            appearance: AppearanceSettingsSchema,
            memberDefaultAgent: z.object({
              defaultAgentId: z.string().uuid().nullable(),
              personalChatAgentId: z.string().uuid().nullable(),
            }),
            memberDefaultModel: z.object({
              modelId: z.string().uuid().nullable(),
              chatApiKeyId: z.string().uuid().nullable(),
            }),
          }),
        ),
      },
    },
    async ({ user, organizationId }, reply) => {
      const [
        permissions,
        scopedCapabilities,
        organization,
        publicConfig,
        appearance,
        defaultAgentId,
        personalChatAgentId,
        memberDefaultModel,
      ] = await Promise.all([
        getUserPermissions({ userId: user.id, organizationId }),
        // SPDX-SnippetBegin
        // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
        // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
        ResourcePermissions.resolveAll({
          userId: user.id,
          organizationId,
        }).then(withoutWildcardCoveredGrants),
        // SPDX-SnippetEnd
        OrganizationModel.getById(organizationId),
        getPublicConfigResponse(),
        OrganizationModel.getAppearanceSettings(),
        MemberModel.getDefaultAgentId(user.id, organizationId),
        // A lookup only: reading the defaults must never seed an assistant.
        AgentModel.findPersonalChatAgentId({
          userId: user.id,
          organizationId,
        }),
        MemberModel.getDefaultModelSelection(user.id, organizationId),
      ]);

      return reply.send({
        permissions,
        scopedCapabilities,
        organization: organization ?? null,
        config: getConfigResponse(),
        publicConfig,
        appearance,
        memberDefaultAgent: { defaultAgentId, personalChatAgentId },
        memberDefaultModel,
      });
    },
  );
};

export default bootstrapRoutes;
