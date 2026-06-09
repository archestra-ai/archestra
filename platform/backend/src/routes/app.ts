import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { getAppTemplates } from "@/app-templates";
import config from "@/config";
import logger from "@/logging";
import {
  AppModel,
  AppTeamModel,
  AppToolModel,
  AppVersionModel,
  TeamModel,
} from "@/models";
import {
  assignToolToApp,
  type ToolAssignmentError,
} from "@/services/agent-tool-assignment";
import {
  assertCallerMayModifyApp,
  callerIsAppAdmin,
} from "@/services/apps/app-authorization";
import { buildValidatedVersionPayload } from "@/services/apps/app-ui-policy";
import {
  ApiError,
  type App,
  AppTemplateSchema,
  CreateAppSchema,
  CredentialResolutionModeSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  SelectAppSchema,
  SelectAppVersionSchema,
  SelectToolSchema,
  UpdateAppSchema,
  UuidIdSchema,
} from "@/types";

// REST bodies extend the shared create/update schemas (kept in sync with the
// create_app/update_app MCP tools) with team assignments, which only the REST
// surface needs for team-scoped apps.
const CreateAppBodySchema = CreateAppSchema.extend({
  teamIds: z.array(UuidIdSchema).optional(),
});
const UpdateAppBodySchema = UpdateAppSchema.extend({
  teamIds: z.array(UuidIdSchema).optional(),
});

const appRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Ships dark: routes are always registered (so they appear in the OpenAPI
  // spec + generated client), but every request 404s until the feature is on.
  fastify.addHook("onRequest", async () => {
    if (!config.apps.enabled) {
      throw new ApiError(404, "Not found");
    }
  });

  fastify.get(
    "/api/apps",
    {
      schema: {
        operationId: RouteId.GetApps,
        description: "List apps visible to the caller (paginated).",
        tags: ["Apps"],
        querystring: PaginationQuerySchema.extend({
          search: z.string().optional(),
        }),
        response: constructResponseSchema(
          createPaginatedResponseSchema(SelectAppSchema),
        ),
      },
    },
    async ({ query, user, organizationId }, reply) => {
      const accessibleAppIds = await AppTeamModel.getUserAccessibleAppIds({
        organizationId,
        userId: user.id,
      });
      const filters = {
        organizationId,
        accessibleAppIds,
        ...(query.search ? { search: query.search } : {}),
      };
      const [data, total] = await Promise.all([
        AppModel.findByOrganization({
          ...filters,
          limit: query.limit,
          offset: query.offset,
        }),
        AppModel.countByOrganization(filters),
      ]);
      return reply.send({
        data,
        pagination: calculatePaginationMeta(total, query),
      });
    },
  );

  fastify.get(
    "/api/app-templates",
    {
      schema: {
        operationId: RouteId.GetAppTemplates,
        description: "List the curated starter templates a new app can use.",
        tags: ["Apps"],
        response: constructResponseSchema(z.array(AppTemplateSchema)),
      },
    },
    async (_request, reply) => {
      return reply.send(getAppTemplates());
    },
  );

  fastify.post(
    "/api/apps",
    {
      schema: {
        operationId: RouteId.CreateApp,
        description: "Create a new MCP App.",
        tags: ["Apps"],
        body: CreateAppBodySchema,
        response: constructResponseSchema(SelectAppSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      const scope = body.scope ?? "personal";
      const teamIds = await resolveOrgTeamIds(body.teamIds, organizationId);
      if (scope === "team" && teamIds.length === 0) {
        throw new ApiError(
          400,
          "A team-scoped app requires at least one teamId.",
        );
      }
      await assertCallerMayModifyApp({
        userId: user.id,
        organizationId,
        scope,
        authorId: user.id,
        resourceTeamIds: teamIds,
      });
      const payload = buildValidatedVersionPayload({
        html: body.html,
        uiCsp: body.uiCsp,
        uiPermissions: body.uiPermissions,
      });
      const app = await AppModel.create({
        app: {
          organizationId,
          authorId: user.id,
          scope,
          name: body.name,
          description: body.description ?? null,
          templateId: body.templateId ?? null,
        },
        payload,
        teamIds,
      });
      if (!app) {
        throw new ApiError(
          409,
          `An app named "${body.name}" already exists in this scope.`,
        );
      }
      return reply.send(app);
    },
  );

  fastify.get(
    "/api/apps/:appId",
    {
      schema: {
        operationId: RouteId.GetApp,
        description: "Get a single app by id, if the caller may view it.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        response: constructResponseSchema(SelectAppSchema),
      },
    },
    async ({ params: { appId }, user, organizationId }, reply) => {
      const app = await loadViewableApp({
        appId,
        userId: user.id,
        organizationId,
      });
      return reply.send(app);
    },
  );

  fastify.patch(
    "/api/apps/:appId",
    {
      schema: {
        operationId: RouteId.UpdateApp,
        description:
          "Update an app's metadata and/or html (forks a new version).",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        body: UpdateAppBodySchema,
        response: constructResponseSchema(SelectAppSchema),
      },
    },
    async ({ params: { appId }, body, user, organizationId }, reply) => {
      // CSP/permissions live in the version envelope, so they can only change
      // alongside new html (mirrors the update_app MCP tool — no silent no-op).
      if (
        body.html === undefined &&
        (body.uiCsp !== undefined || body.uiPermissions !== undefined)
      ) {
        throw new ApiError(
          400,
          "Changing uiCsp or uiPermissions requires supplying html (they are part of the app version).",
        );
      }

      const app = await loadViewableApp({
        appId,
        userId: user.id,
        organizationId,
      });
      const resourceTeamIds = await AppTeamModel.getTeamsForApp(app.id);
      const nextTeamIds =
        body.teamIds !== undefined
          ? await resolveOrgTeamIds(body.teamIds, organizationId)
          : undefined;

      await assertCallerMayModifyApp({
        userId: user.id,
        organizationId,
        scope: app.scope,
        authorId: app.authorId,
        resourceTeamIds,
      });
      // Authorize the destination whenever the team set or scope changes — a
      // team admin must not redirect an app to teams they don't administer, even
      // with the scope unchanged.
      const destScope = body.scope ?? app.scope;
      const effectiveTeamIds = nextTeamIds ?? resourceTeamIds;
      if (destScope === "team" && effectiveTeamIds.length === 0) {
        throw new ApiError(
          400,
          "A team-scoped app requires at least one teamId.",
        );
      }
      const reScoping = body.scope !== undefined && body.scope !== app.scope;
      if (reScoping || nextTeamIds !== undefined) {
        await assertCallerMayModifyApp({
          userId: user.id,
          organizationId,
          scope: destScope,
          authorId: app.authorId,
          resourceTeamIds: nextTeamIds ?? resourceTeamIds,
        });
      }

      const patch: Partial<Pick<App, "name" | "description" | "scope">> = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.scope !== undefined) patch.scope = body.scope;

      // CSP/permissions ride the version envelope; an html-bearing edit inherits
      // the current head's values for any field the caller omits.
      let version: ReturnType<typeof buildValidatedVersionPayload> | undefined;
      if (body.html !== undefined) {
        const head = await AppVersionModel.findByAppAndVersion(
          app.id,
          app.latestVersion,
        );
        version = buildValidatedVersionPayload({
          html: body.html,
          uiCsp: body.uiCsp !== undefined ? body.uiCsp : (head?.uiCsp ?? null),
          uiPermissions:
            body.uiPermissions !== undefined
              ? body.uiPermissions
              : (head?.uiPermissions ?? null),
        });
      }

      const updated = await AppModel.update({
        id: appId,
        ...(Object.keys(patch).length > 0 ? { patch } : {}),
        ...(version ? { version } : {}),
        ...(nextTeamIds !== undefined ? { teamIds: nextTeamIds } : {}),
      });
      if (!updated) {
        throw new ApiError(404, `No app found with id ${appId}.`);
      }
      return reply.send(updated);
    },
  );

  fastify.delete(
    "/api/apps/:appId",
    {
      schema: {
        operationId: RouteId.DeleteApp,
        description: "Soft-delete an app the caller owns or administers.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { appId }, user, organizationId }, reply) => {
      const app = await loadViewableApp({
        appId,
        userId: user.id,
        organizationId,
      });
      await assertCallerMayModifyApp({
        userId: user.id,
        organizationId,
        scope: app.scope,
        authorId: app.authorId,
        resourceTeamIds: await AppTeamModel.getTeamsForApp(app.id),
      });
      const success = await AppModel.delete(appId);
      if (!success) {
        throw new ApiError(404, `No app found with id ${appId}.`);
      }
      logger.info({ appId, userId: user.id }, "App deleted via REST");
      return reply.send({ success });
    },
  );

  fastify.get(
    "/api/apps/:appId/versions",
    {
      schema: {
        operationId: RouteId.GetAppVersions,
        description: "List an app's versions, newest first.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        response: constructResponseSchema(z.array(SelectAppVersionSchema)),
      },
    },
    async ({ params: { appId }, user, organizationId }, reply) => {
      await loadViewableApp({ appId, userId: user.id, organizationId });
      return reply.send(await AppVersionModel.listForApp(appId));
    },
  );

  fastify.get(
    "/api/apps/:appId/versions/:version",
    {
      schema: {
        operationId: RouteId.GetAppVersion,
        description: "Get a specific app version.",
        tags: ["Apps"],
        params: z.object({
          appId: UuidIdSchema,
          version: z.coerce.number().int().positive(),
        }),
        response: constructResponseSchema(SelectAppVersionSchema),
      },
    },
    async ({ params: { appId, version }, user, organizationId }, reply) => {
      await loadViewableApp({ appId, userId: user.id, organizationId });
      const row = await AppVersionModel.findByAppAndVersion(appId, version);
      if (!row) {
        throw new ApiError(404, `App ${appId} has no version ${version}.`);
      }
      return reply.send(row);
    },
  );

  fastify.get(
    "/api/apps/:appId/tools",
    {
      schema: {
        operationId: RouteId.GetAppTools,
        description: "List the tools assigned to an app.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        response: constructResponseSchema(z.array(SelectToolSchema)),
      },
    },
    async ({ params: { appId }, user, organizationId }, reply) => {
      await loadViewableApp({ appId, userId: user.id, organizationId });
      return reply.send(await AppToolModel.getToolsForApp(appId));
    },
  );

  fastify.post(
    "/api/apps/:appId/tools/:toolId",
    {
      schema: {
        operationId: RouteId.AssignToolToApp,
        description: "Assign an upstream tool to an app.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema, toolId: UuidIdSchema }),
        body: z
          .object({
            mcpServerId: UuidIdSchema.nullable().optional(),
            credentialResolutionMode: CredentialResolutionModeSchema.optional(),
          })
          .optional(),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async (
      { params: { appId, toolId }, body, user, organizationId },
      reply,
    ) => {
      await assertCallerMayModifyAppById({
        appId,
        userId: user.id,
        organizationId,
      });
      const result = await assignToolToApp({
        appId,
        toolId,
        mcpServerId: body?.mcpServerId,
        credentialResolutionMode: body?.credentialResolutionMode,
      });
      if (isAssignmentError(result)) {
        throw new ApiError(
          result.code === "not_found" ? 404 : 400,
          result.error.message,
        );
      }
      return reply.send({ success: true });
    },
  );

  fastify.delete(
    "/api/apps/:appId/tools/:toolId",
    {
      schema: {
        operationId: RouteId.UnassignToolFromApp,
        description: "Unassign a tool from an app.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema, toolId: UuidIdSchema }),
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ params: { appId, toolId }, user, organizationId }, reply) => {
      await assertCallerMayModifyAppById({
        appId,
        userId: user.id,
        organizationId,
      });
      const success = await AppToolModel.delete(appId, toolId);
      if (!success) {
        throw new ApiError(404, "App tool not found");
      }
      return reply.send({ success });
    },
  );
};

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Dedupe team ids and verify every one belongs to the caller's organization, so
 * a cross-org team id can never become an access principal for an app. Throws
 * `ApiError(400)` on an unknown/foreign team. Returns the deduped list.
 */
async function resolveOrgTeamIds(
  teamIds: string[] | undefined,
  organizationId: string,
): Promise<string[]> {
  const unique = [...new Set(teamIds ?? [])];
  if (unique.length === 0) return [];
  const teams = await TeamModel.findByIds(unique);
  const inOrg = new Set(
    teams.filter((t) => t.organizationId === organizationId).map((t) => t.id),
  );
  const invalid = unique.filter((id) => !inOrg.has(id));
  if (invalid.length > 0) {
    throw new ApiError(
      400,
      `Unknown team(s) for this organization: ${invalid.join(", ")}`,
    );
  }
  return unique;
}

/** Load an app the caller may view, or throw 404 (no existence leak). */
async function loadViewableApp(params: {
  appId: string;
  userId: string;
  organizationId: string;
}): Promise<App> {
  const app = await AppModel.findByIdForCaller({
    id: params.appId,
    organizationId: params.organizationId,
    userId: params.userId,
    isAppAdmin: await callerIsAppAdmin(params.userId, params.organizationId),
  });
  if (!app) {
    throw new ApiError(404, `No app found with id ${params.appId}.`);
  }
  return app;
}

/** Load + scope-modify-authorize an app for a tool assignment change. */
async function assertCallerMayModifyAppById(params: {
  appId: string;
  userId: string;
  organizationId: string;
}): Promise<void> {
  const app = await loadViewableApp(params);
  await assertCallerMayModifyApp({
    userId: params.userId,
    organizationId: params.organizationId,
    scope: app.scope,
    authorId: app.authorId,
    resourceTeamIds: await AppTeamModel.getTeamsForApp(app.id),
  });
}

function isAssignmentError(
  result: ToolAssignmentError | "duplicate" | "updated" | null,
): result is ToolAssignmentError {
  return result !== null && result !== "duplicate" && result !== "updated";
}

export default appRoutes;
