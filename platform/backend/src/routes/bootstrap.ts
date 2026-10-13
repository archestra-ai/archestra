import {
  ManagedResourceSchema,
  PermissionsSchema,
  ResourcePermissionActionSchema,
  ResourcePermissionScopeSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { OrganizationModel } from "@/models";
// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { ResourcePermissions } from "@/services/resource-permissions";
// SPDX-SnippetEnd
import { getUserPermissions } from "@/services/user";
import { constructResponseSchema, SelectOrganizationSchema } from "@/types";
import { ConfigResponseSchema, getConfigResponse } from "./config";

/**
 * The reads the app shell needs before it can draw a page, in one round trip.
 * The frontend fires this alongside the session check on a cold load and
 * seeds each part into the query its own endpoint feeds, so the shell skips a
 * second wave of requests.
 */
const bootstrapRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    "/api/bootstrap",
    {
      schema: {
        operationId: RouteId.GetBootstrap,
        description:
          "Get the signed-in user's permissions, organization, and platform config in one request",
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
          }),
        ),
      },
    },
    async ({ user, organizationId }, reply) => {
      const [permissions, scopedCapabilities, organization] = await Promise.all(
        [
          getUserPermissions({ userId: user.id, organizationId }),
          // SPDX-SnippetBegin
          // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
          // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
          ResourcePermissions.resolveAll({ userId: user.id, organizationId }),
          // SPDX-SnippetEnd
          OrganizationModel.getById(organizationId),
        ],
      );

      return reply.send({
        permissions,
        scopedCapabilities,
        organization: organization ?? null,
        config: getConfigResponse(),
      });
    },
  );
};

export default bootstrapRoutes;
