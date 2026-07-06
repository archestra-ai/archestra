import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  DEFAULT_APP_TEMPLATE_ID,
  getAppTemplates,
  resolveCreateAppHtml,
} from "@/app-templates";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import {
  AppAccessModel,
  AppModel,
  AppPinModel,
  AppRenderDiagnosticsModel,
  AppRenderScreenshotModel,
  AppToolModel,
  AppVersionModel,
  McpServerModel,
} from "@/models";
import type { VersionPayload } from "@/models/app-version";
import {
  assignToolToApp,
  type ToolAssignmentError,
} from "@/services/agent-tool-assignment";
import {
  assertCallerMayModifyApp,
  callerIsAppAdmin,
  resolveOrgTeams,
} from "@/services/apps/app-authorization";
import {
  createSeededAppConversation,
  createSeededExternalAppConversation,
} from "@/services/apps/app-chat-conversation";
import {
  createAppBacking,
  deleteAppBacking,
  syncAppBacking,
} from "@/services/apps/app-mcp-backing";
import { buildValidatedVersionPayload } from "@/services/apps/app-ui-policy";
import { assertCanAssignEnvironment } from "@/services/environments/environment";
import {
  ApiError,
  type App,
  type AppListItem,
  AppListItemSchema,
  AppRenderDiagnosticEntrySchema,
  AppTemplateSchema,
  CreateAppSchema,
  CredentialResolutionModeSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ExternalAppResolutionSchema,
  SelectAppSchema,
  SelectAppVersionSchema,
  SelectToolSchema,
  UpdateAppSchema,
  UuidIdSchema,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

// REST bodies extend the shared create/update schemas with team assignments,
// which only the REST surface needs for team-scoped apps.
const CreateAppBodySchema = CreateAppSchema.extend({
  teamIds: z.array(UuidIdSchema).optional(),
  // When set, also create a chat conversation with this app already rendered, so
  // the client opens it directly at `/chat/<conversationId>` with no model turn.
  openInChat: z.boolean().optional(),
});
const UpdateAppBodySchema = UpdateAppSchema.extend({
  teamIds: z.array(UuidIdSchema).optional(),
});

// Create/update responses carry soft save-time validation warnings (the save
// succeeded; the html has structural issues worth surfacing to the author).
const AppWithWarningsSchema = SelectAppSchema.extend({
  warnings: z.array(z.string()).optional(),
});

// Create response additionally carries the seeded chat conversation id when the
// app was created with `openInChat` (absent if seeding was skipped or failed).
const CreateAppResponseSchema = AppWithWarningsSchema.extend({
  conversationId: z.string().uuid().optional(),
});

// open-in-chat returns the seeded conversation to navigate to (`/chat/<id>`).
const OpenAppInChatResponseSchema = z.object({
  conversationId: z.string().uuid(),
});

// The external variant also says how the conversation was set up: "render"
// seeds the app already mounted; "prompt" leaves it empty and the client sends
// `prompt` as the first user message (the tool has required inputs the agent
// must collect before calling it).
const OpenExternalAppInChatResponseSchema = OpenAppInChatResponseSchema.extend({
  mode: z.enum(["render", "prompt"]),
  prompt: z.string().optional(),
});

// The single-app GET resolves the app's team assignments so the detail page can
// render team-name badges and seed the visibility editor.
const AppWithTeamsSchema = SelectAppSchema.extend({
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
});

const appRoutes: FastifyPluginAsyncZod = async (fastify) => {
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
          createPaginatedResponseSchema(AppListItemSchema),
        ),
      },
    },
    async ({ query, user, organizationId }, reply) => {
      // The Apps surface unifies two sources: owned apps (this org's app rows)
      // and external UI-providing installed MCP servers. Both are access-filtered
      // by their own model; we merge, sort, and paginate over the combined set.
      // Cardinality is small (tens), so fetching all-then-slicing is fine.
      const accessibleAppIds = await AppAccessModel.getUserAccessibleAppIds({
        organizationId,
        userId: user.id,
      });
      const ownedFilters = {
        organizationId,
        accessibleAppIds,
        ...(query.search ? { search: query.search } : {}),
      };
      const [ownedCount, external] = await Promise.all([
        AppModel.countByOrganization(ownedFilters),
        McpServerModel.findUiCapableForCaller({
          userId: user.id,
          organizationId,
          ...(query.search ? { search: query.search } : {}),
        }),
      ]);
      const owned = await AppModel.findByOrganization({
        ...ownedFilters,
        limit: ownedCount,
        offset: 0,
      });
      const [teamsByApp, ownedPins, externalPins] = await Promise.all([
        AppAccessModel.getTeamDetailsForApps(owned.map((app) => app.id)),
        // Per-user pins (mirrors the projects list): surfaced as `pinnedAt` so
        // the client can group pinned-first, like the Projects page.
        AppPinModel.getPinnedAtForApps({
          userId: user.id,
          appIds: owned.map((app) => app.id),
        }),
        AppPinModel.getPinnedAtForExternalApps({
          userId: user.id,
          refs: external.map((catalogApp) => ({
            mcpServerId: catalogApp.mcpServerId,
            resourceUri: catalogApp.resourceUri,
          })),
        }),
      ]);

      const items: AppListItem[] = [
        ...owned.map((app) => ({
          source: "owned" as const,
          id: app.id,
          name: app.name,
          description: app.description,
          scope: app.scope,
          authorId: app.authorId,
          latestVersion: app.latestVersion,
          teams: teamsByApp.get(app.id) ?? [],
          executionModel: "viewer-scoped" as const,
          cspOrigin: "platform-pinned" as const,
          pinnedAt: ownedPins.get(app.id) ?? null,
        })),
        ...external.map((catalogApp) => ({
          source: "external" as const,
          catalogId: catalogApp.catalogId,
          mcpServerId: catalogApp.mcpServerId,
          scope: catalogApp.scope,
          // "Server / Tool" as the title (short tool name, never the slug
          // prefix); the tool's own description as the subtitle.
          name: `${catalogApp.serverName} / ${catalogApp.toolName}`,
          description: catalogApp.toolDescription,
          resourceUri: catalogApp.resourceUri,
          // The server's registry icon (emoji or data URL) so the card can
          // show which server the app comes from.
          icon: catalogApp.serverIcon,
          executionModel: "server-scoped" as const,
          cspOrigin: "author-declared" as const,
          pinnedAt:
            externalPins.get(
              AppPinModel.externalPinKey({
                mcpServerId: catalogApp.mcpServerId,
                resourceUri: catalogApp.resourceUri,
              }),
            ) ?? null,
        })),
      ];
      items.sort((a, b) => a.name.localeCompare(b.name));

      return reply.send({
        data: items.slice(query.offset, query.offset + query.limit),
        pagination: calculatePaginationMeta(items.length, query),
      });
    },
  );

  fastify.get(
    "/api/apps/external/:catalogId",
    {
      schema: {
        operationId: RouteId.GetExternalApp,
        description:
          "Resolve an external UI-providing app by catalog id: its UI resource and the caller's accessible installs (for the standalone run page's install selector).",
        tags: ["Apps"],
        params: z.object({ catalogId: UuidIdSchema }),
        response: constructResponseSchema(ExternalAppResolutionSchema),
      },
    },
    async ({ params, user, organizationId }, reply) => {
      const resolved = await McpServerModel.findCatalogAppForCaller({
        userId: user.id,
        organizationId,
        catalogId: params.catalogId,
      });
      if (!resolved) {
        throw new ApiError(404, "Not found");
      }
      return reply.send(resolved);
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
        response: constructResponseSchema(CreateAppResponseSchema),
      },
    },
    async ({ body, user, organizationId }, reply) => {
      const scope = body.scope ?? "personal";
      const teamIds = await resolveOrgTeams(body.teamIds, organizationId);
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
      await assertEnvironmentAssignable({
        userId: user.id,
        organizationId,
        environmentId: body.environmentId ?? null,
      });
      const { html, seededFromTemplate } = resolveCreateAppHtml({
        html: body.html,
        name: body.name,
      });
      const { payload, warnings } = await buildValidatedVersionPayload({
        html,
        uiPermissions: body.uiPermissions,
      });
      // App names are unique per author (apps_org_author_name_uidx); a duplicate
      // fails this insert before any backing is created.
      const created = await AppModel.create({
        app: {
          organizationId,
          authorId: user.id,
          name: body.name,
          description: body.description ?? null,
          templateId: seededFromTemplate ? DEFAULT_APP_TEMPLATE_ID : null,
        },
        payload,
      }).catch((error) => {
        if (isUniqueConstraintError(error)) {
          throw new ApiError(
            409,
            `You already have an app named "${body.name}".`,
          );
        }
        throw error;
      });
      // An app must never exist without its backing (the catalog owns its
      // visibility + environment); on backing failure delete the app row.
      try {
        await createAppBacking({
          app: created,
          scope,
          environmentId: body.environmentId ?? null,
          userId: user.id,
          organizationId,
          teamIds,
        });
      } catch (error) {
        await AppModel.purge(created.id);
        throw error;
      }
      const app = await AppModel.findById(created.id);
      if (!app) throw new ApiError(500, "App created but could not be loaded.");

      // Optionally open the new app in chat in this same request: seed a
      // conversation with the app already rendered so the client navigates
      // straight to `/chat/<conversationId>`. Best-effort — the app is created
      // regardless; if seeding fails (e.g. no LLM configured) we return the app
      // without a conversationId and the client falls back to the apps page.
      let conversationId: string | undefined;
      if (body.openInChat) {
        try {
          ({ conversationId } = await createSeededAppConversation({
            appId: app.id,
            userId: user.id,
            organizationId,
          }));
        } catch (error) {
          logger.warn(
            { err: error, appId: app.id },
            "Failed to seed chat conversation for newly created app",
          );
        }
      }

      return reply.send({
        ...app,
        ...(warnings.length > 0 ? { warnings } : {}),
        ...(conversationId ? { conversationId } : {}),
      });
    },
  );

  fastify.post(
    "/api/apps/:appId/open-in-chat",
    {
      schema: {
        operationId: RouteId.OpenAppInChat,
        description:
          "Open an existing app in chat: create a conversation with the app already rendered (no model turn) and return its id to navigate to.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        response: constructResponseSchema(OpenAppInChatResponseSchema),
      },
    },
    async ({ params: { appId }, user, organizationId }, reply) => {
      // The service re-checks app visibility (404s if the caller can't view it).
      const { conversationId } = await createSeededAppConversation({
        appId,
        userId: user.id,
        organizationId,
      });
      return reply.send({ conversationId });
    },
  );

  fastify.post(
    "/api/apps/external/:mcpServerId/open-in-chat",
    {
      schema: {
        operationId: RouteId.OpenExternalAppInChat,
        description:
          "Open an external (MCP-server) UI app in chat: create a conversation and return its id to navigate to. When the tool needs no inputs the app is seeded already rendered (no model turn); when it has required inputs the conversation is created empty and the response carries an opening prompt for the client to send.",
        tags: ["Apps"],
        params: z.object({ mcpServerId: UuidIdSchema }),
        body: z.object({ resourceUri: z.string().min(1) }),
        response: constructResponseSchema(OpenExternalAppInChatResponseSchema),
      },
    },
    async (
      { params: { mcpServerId }, body: { resourceUri }, user, organizationId },
      reply,
    ) => {
      // The service re-checks install access + that the resource exists (404s
      // otherwise).
      const result = await createSeededExternalAppConversation({
        mcpServerId,
        resourceUri,
        userId: user.id,
        organizationId,
      });
      return reply.send(result);
    },
  );

  fastify.put(
    "/api/apps/:appId/pin",
    {
      schema: {
        operationId: RouteId.PinApp,
        description:
          "Pin an app for the current user (mirrors project pins). Personal — " +
          "does not affect other members. Any user who can view the app may pin it.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { appId }, user, organizationId }, reply) => {
      await loadViewableApp({ appId, userId: user.id, organizationId });
      await AppPinModel.pinOwned({ userId: user.id, appId });
      return reply.send({ ok: true as const });
    },
  );

  fastify.delete(
    "/api/apps/:appId/pin",
    {
      schema: {
        operationId: RouteId.UnpinApp,
        description:
          "Remove the current user's pin on an app. Idempotent; intentionally " +
          "no visibility check, so a stale pin on an app that was since " +
          "re-scoped away (or deleted) can still be cleared.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { appId }, user }, reply) => {
      await AppPinModel.unpinOwned({ userId: user.id, appId });
      return reply.send({ ok: true as const });
    },
  );

  fastify.put(
    "/api/apps/external/:mcpServerId/pin",
    {
      schema: {
        operationId: RouteId.PinExternalApp,
        description:
          "Pin an external (MCP-server) UI app for the current user, identified " +
          "like open-in-chat by install + resource. Personal — does not affect " +
          "other members.",
        tags: ["Apps"],
        params: z.object({ mcpServerId: UuidIdSchema }),
        body: z.object({ resourceUri: z.string().min(1) }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async ({ params: { mcpServerId }, body: { resourceUri }, user }, reply) => {
      // Same gate as external open-in-chat: the install must be accessible and
      // actually expose this UI resource (404s otherwise, no existence leak).
      const uiResource = await McpServerModel.findInstalledUiResourceForCaller({
        userId: user.id,
        mcpServerId,
        resourceUri,
      });
      if (!uiResource) {
        throw new ApiError(404, "No runnable app found for this install.");
      }
      await AppPinModel.pinExternal({
        userId: user.id,
        mcpServerId,
        resourceUri,
      });
      return reply.send({ ok: true as const });
    },
  );

  fastify.delete(
    "/api/apps/external/:mcpServerId/pin",
    {
      schema: {
        operationId: RouteId.UnpinExternalApp,
        description:
          "Remove the current user's pin on an external app. Idempotent; " +
          "intentionally no access check, so a stale pin on an install the " +
          "user lost access to can still be cleared. `resourceUri` rides the " +
          "query string (DELETE carries no body).",
        tags: ["Apps"],
        params: z.object({ mcpServerId: UuidIdSchema }),
        querystring: z.object({ resourceUri: z.string().min(1) }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async (
      { params: { mcpServerId }, query: { resourceUri }, user },
      reply,
    ) => {
      await AppPinModel.unpinExternal({
        userId: user.id,
        mcpServerId,
        resourceUri,
      });
      return reply.send({ ok: true as const });
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
        response: constructResponseSchema(AppWithTeamsSchema),
      },
    },
    async ({ params: { appId }, user, organizationId }, reply) => {
      const app = await loadViewableApp({
        appId,
        userId: user.id,
        organizationId,
      });
      const teamsByApp = await AppAccessModel.getTeamDetailsForApps([app.id]);
      return reply.send({ ...app, teams: teamsByApp.get(app.id) ?? [] });
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
        response: constructResponseSchema(AppWithWarningsSchema),
      },
    },
    async ({ params: { appId }, body, user, organizationId }, reply) => {
      // Permissions live in the version envelope, so they can only change
      // alongside new html (no silent no-op).
      if (body.html === undefined && body.uiPermissions !== undefined) {
        throw new ApiError(
          400,
          "Changing uiPermissions requires supplying html (they are part of the app version).",
        );
      }

      const app = await loadViewableApp({
        appId,
        userId: user.id,
        organizationId,
      });
      const resourceTeamIds = await AppAccessModel.getTeamsForApp(app.id);
      const nextTeamIds =
        body.teamIds !== undefined
          ? await resolveOrgTeams(body.teamIds, organizationId)
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

      // Re-binding the environment is authorized like the initial bind: org
      // membership + the restricted-env permission. Only an actual change is
      // re-authorized — editing other fields of an app bound to a restricted
      // environment must not require deploy-to-restricted (the settings form
      // echoes the unchanged environmentId). Existing tool assignments are not
      // stripped here; out-of-environment ones are refused at call time.
      if (
        body.environmentId !== undefined &&
        body.environmentId !== app.environmentId
      ) {
        await assertEnvironmentAssignable({
          userId: user.id,
          organizationId,
          environmentId: body.environmentId,
        });
      }

      const patch: Partial<
        Pick<App, "name" | "description" | "scope" | "environmentId">
      > = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.description !== undefined) patch.description = body.description;
      if (body.scope !== undefined) patch.scope = body.scope;
      if (body.environmentId !== undefined)
        patch.environmentId = body.environmentId;

      // Permissions ride the version envelope; an html-bearing edit inherits
      // the current head's value when the caller omits it.
      let version: VersionPayload | undefined;
      let warnings: string[] = [];
      if (body.html !== undefined) {
        const head = await AppVersionModel.findByAppAndVersion(
          app.id,
          app.latestVersion,
        );
        const validated = await buildValidatedVersionPayload({
          html: body.html,
          uiPermissions:
            body.uiPermissions !== undefined
              ? body.uiPermissions
              : (head?.uiPermissions ?? null),
        });
        version = validated.payload;
        warnings = validated.warnings;
      }

      const updated = await AppModel.update({
        id: appId,
        ...(Object.keys(patch).length > 0 ? { patch } : {}),
        ...(version ? { version } : {}),
        ...(nextTeamIds !== undefined ? { teamIds: nextTeamIds } : {}),
      }).catch((error) => {
        // A rename into a name this author already uses hits apps_org_author_name_uidx.
        if (body.name !== undefined && isUniqueConstraintError(error)) {
          throw new ApiError(
            409,
            `You already have an app named "${body.name}".`,
          );
        }
        throw error;
      });
      if (!updated) {
        throw new ApiError(404, `No app found with id ${appId}.`);
      }
      await syncAppBacking(updated);
      return reply.send(
        warnings.length > 0 ? { ...updated, warnings } : updated,
      );
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
        resourceTeamIds: await AppAccessModel.getTeamsForApp(app.id),
      });
      const success = await AppModel.delete(appId);
      if (!success) {
        throw new ApiError(404, `No app found with id ${appId}.`);
      }
      await deleteAppBacking(app);
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
    "/api/apps/:appId/diagnostics",
    {
      schema: {
        operationId: RouteId.PostAppRenderDiagnostics,
        description:
          "Record the calling user's latest render diagnostics for an app. An empty entries array means the render was clean.",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        body: z.object({
          version: z.number().int().positive(),
          entries: z.array(AppRenderDiagnosticEntrySchema).max(50),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { appId }, body, user, organizationId }, reply) => {
      // The iframe never calls this — the trusted host page does — but the
      // endpoint must not trust an arbitrary appId regardless. user_id comes
      // only from the session.
      const app = await loadViewableApp({
        appId,
        userId: user.id,
        organizationId,
      });
      // An app cannot have rendered a version it doesn't have yet; rejecting a
      // future version stops a stale/buggy client from pinning a snapshot that
      // masks the real head from get_app_diagnostics.
      if (body.version > app.latestVersion) {
        throw new ApiError(
          400,
          `version ${body.version} exceeds the app's latest version ${app.latestVersion}.`,
        );
      }
      await AppRenderDiagnosticsModel.record({
        appId,
        userId: user.id,
        version: body.version,
        entries: body.entries,
      });
      return reply.send({ success: true });
    },
  );

  fastify.post(
    "/api/apps/:appId/screenshot",
    {
      schema: {
        operationId: RouteId.PostAppRenderScreenshot,
        description:
          "Record the calling user's latest render screenshot for an app (a base64 image data URL the app self-captured).",
        tags: ["Apps"],
        params: z.object({ appId: UuidIdSchema }),
        body: z.object({
          version: z.number().int().positive(),
          // ~2MB of base64 covers a downscaled JPEG; the SDK caps before posting.
          dataUrl: z
            .string()
            .max(2_000_000)
            .regex(
              /^data:image\/(png|jpeg|webp);base64,/,
              "must be a base64 image data URL",
            ),
        }),
        response: constructResponseSchema(z.object({ success: z.boolean() })),
      },
    },
    async ({ params: { appId }, body, user, organizationId }, reply) => {
      // Same trust model as diagnostics: the trusted host page posts this, never
      // the iframe, but the appId is still re-checked and user_id comes only from
      // the session.
      const app = await loadViewableApp({
        appId,
        userId: user.id,
        organizationId,
      });
      if (body.version > app.latestVersion) {
        throw new ApiError(
          400,
          `version ${body.version} exceeds the app's latest version ${app.latestVersion}.`,
        );
      }
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s.exec(
        body.dataUrl,
      );
      if (!match) {
        throw new ApiError(400, "invalid image data URL.");
      }
      const [, mimeType, data] = match;
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw new ApiError(400, "image data is not valid base64.");
      }
      await AppRenderScreenshotModel.record({
        appId,
        userId: user.id,
        version: body.version,
        mimeType,
        data,
      });
      return reply.send({ success: true });
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
        organizationId,
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
    resourceTeamIds: await AppAccessModel.getTeamsForApp(app.id),
  });
}

function isAssignmentError(
  result: ToolAssignmentError | "duplicate" | "updated" | null,
): result is ToolAssignmentError {
  return result !== null && result !== "duplicate" && result !== "updated";
}

/**
 * Authorize binding an app to `environmentId` (null = org default). Mirrors the
 * agent/knowledge-base/MCP-catalog path: org membership of the environment plus
 * the restricted-env permission are enforced by `assertCanAssignEnvironment`,
 * which also gates a restricted *default* environment.
 */
async function assertEnvironmentAssignable(params: {
  userId: string;
  organizationId: string;
  environmentId: string | null;
}): Promise<void> {
  const { userId, organizationId, environmentId } = params;
  const [hasEnvAdmin, hasEnvDeploy] = await Promise.all([
    userHasPermission(userId, organizationId, "environment", "admin"),
    userHasPermission(
      userId,
      organizationId,
      "environment",
      "deploy-to-restricted",
    ),
  ]);
  await assertCanAssignEnvironment({
    environmentId,
    organizationId,
    canDeployToRestricted: hasEnvAdmin || hasEnvDeploy,
  });
}

export default appRoutes;
