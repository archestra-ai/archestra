import {
  calculatePaginationMeta,
  createPaginatedResponseSchema,
  PaginationQuerySchema,
  parseLabelsParam,
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
  AgentModel,
  AppAccessModel,
  AppLabelModel,
  AppModel,
  AppPinModel,
  AppRenderDiagnosticsModel,
  AppRenderScreenshotModel,
  AppToolModel,
  AppVersionModel,
  McpCatalogLabelModel,
  McpServerModel,
  UserModel,
} from "@/models";
import type { VersionPayload } from "@/models/app-version";
import { resolveLockedChatCreationIfRequested } from "@/routes/chat/locked-chat";
import {
  assignToolToApp,
  type ToolAssignmentError,
} from "@/services/agent-tool-assignment";
import {
  assertCallerMayAuthorApp,
  assertCallerMayModifyApp,
  callerIsAppAdmin,
  resolveOrgTeams,
  resolveOrgUsers,
} from "@/services/apps/app-authorization";
import {
  createSeededAppConversation,
  createSeededExternalAppConversation,
  resolveDefaultChatAgentId,
} from "@/services/apps/app-chat-conversation";
import {
  createAppBacking,
  deleteAppBacking,
  syncAppBacking,
} from "@/services/apps/app-mcp-backing";
import { buildValidatedVersionPayload } from "@/services/apps/app-ui-policy";
import { resolveNewAppLifecycleDefaults } from "@/services/apps/new-app-defaults";
import {
  assertCanAssignEnvironment,
  resolveDefaultEnvironmentForNewResource,
} from "@/services/environments/environment";
import {
  ApiError,
  type App,
  type AppListItem,
  AppListItemSchema,
  AppRenderDiagnosticEntrySchema,
  AppScopeSchema,
  AppTemplateSchema,
  type AppViewerRole,
  CreateAppSchema,
  CredentialResolutionModeSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  ExternalAppResolutionSchema,
  PublicAppSchema,
  SelectAppVersionSchema,
  SelectToolSchema,
  UpdateAppSchema,
  UuidIdSchema,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";
import { externalAppLabel } from "@/utils/external-app-label";
import {
  BulkDeleteBodySchema,
  BulkIdsSchema,
  BulkOutcomeSchema,
  runBulk,
} from "../bulk-route";

// A comma-joined id list on the query string ("a,b,c" → ["a","b","c"]), for
// the admin owner sub-filter on the list route. Mirrors the Projects list.
const CommaSeparatedIds = z.preprocess(
  (value) =>
    typeof value === "string" ? value.split(",").filter(Boolean) : value,
  z.array(z.string()),
);

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
  // People the app is shared with individually. Additive to `personal` scope
  // rather than a scope of its own, so a personal app can follow a chat shared
  // with named colleagues without widening to a team or the organization.
  // Omitted leaves grants untouched; `[]` revokes them all. Not UUIDs — better-auth
  // user ids are opaque strings.
  userIds: z.array(z.string().min(1)).optional(),
});

// Create/update responses carry soft save-time validation warnings (the save
// succeeded; the html has structural issues worth surfacing to the author).
const AppWithWarningsSchema = PublicAppSchema.extend({
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
// render team-name badges and seed the visibility editor, plus the caller's
// viewerRole so the settings surface can show a "Viewing as administrator"
// banner when an admin opens an app they only see through oversight.
const AppWithTeamsSchema = PublicAppSchema.extend({
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
  // People the app is shared with individually. A non-empty list on a
  // `personal`-scoped app is what the settings form renders as "Users" — the
  // grant lives beside the scope rather than in it.
  users: z.array(
    z.object({ id: z.string(), name: z.string(), email: z.string() }),
  ),
  viewerRole: z.enum(["owner", "shared", "admin"]),
  // The author's display name, so an admin viewing an app they only see through
  // oversight can be shown "Viewing as administrator · <name>". Null when the
  // author row is gone or nameless.
  authorName: z.string().nullable(),
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
          // Visibility filter; absence = "All". Mirrors the Projects list.
          scope: AppScopeSchema.optional(),
          // Admin-only owner sub-filter for personal apps (silently ignored for
          // non-admins): authorIds keeps only these authors, excludeAuthorIds
          // drops them. Used by the "Other users" / user-picker toolbar.
          authorIds: CommaSeparatedIds.optional(),
          excludeAuthorIds: CommaSeparatedIds.optional(),
          labels: z
            .string()
            .optional()
            .describe(
              "Filter by labels. Format: key1:val1|val2;key2:val3. AND across keys, OR within values.",
            ),
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
      const isAppAdmin = await callerIsAppAdmin(user.id, organizationId);
      const accessibleAppIds = await AppAccessModel.getUserAccessibleAppIds({
        organizationId,
        userId: user.id,
        isAppAdmin,
      });
      // Apps the caller reaches WITHOUT the admin bypass. Distinguishes a
      // genuinely-accessible app ("shared") from one seen only through oversight
      // ("admin"), so the card can label the latter and the "All" view can hide
      // it. For a non-admin this is just the accessible set (no extra query).
      const nonAdminAccessibleIds = new Set(
        isAppAdmin
          ? await AppAccessModel.getUserAccessibleAppIds({
              organizationId,
              userId: user.id,
            })
          : accessibleAppIds,
      );
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
      // Resolve author display names for personal apps only — the card shows an
      // "Owned by <author>" badge when an app admin views someone else's
      // personal app, so other scopes don't need the lookup.
      const personalAuthorIds = [
        ...new Set(
          owned
            .filter((app) => app.scope === "personal" && app.authorId !== null)
            .map((app) => app.authorId as string),
        ),
      ];
      const [usersByApp, teamsByApp, authorNames, ownedPins, externalPins] =
        await Promise.all([
          AppAccessModel.getUserDetailsForApps(owned.map((app) => app.id)),
          AppAccessModel.getTeamDetailsForApps(owned.map((app) => app.id)),
          UserModel.getNamesByIds(personalAuthorIds),
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
              toolName: catalogApp.toolName,
            })),
          }),
        ]);

      // An external item's labels are its backing catalog's (edited in the MCP
      // registry), so the one `?labels=` filter spans both halves of the mixed
      // listing instead of silently dropping every external app.
      const externalLabels =
        await McpCatalogLabelModel.getLabelsForCatalogItems([
          ...new Set(external.map((catalogApp) => catalogApp.catalogId)),
        ]);
      const labelFilter = parseLabelsParam(query.labels);

      // Each owned app's relationship to the caller: authored by them (owner),
      // reached through its scope (shared), or seen only via app:admin oversight
      // (admin). Drives the "Owned by <name>" badge and the "All"/owner filters.
      const viewerRoleOf = (app: App): AppViewerRole =>
        app.authorId === user.id
          ? "owner"
          : nonAdminAccessibleIds.has(app.id)
            ? "shared"
            : "admin";

      // The owner sub-filter is admin-only; drop it for everyone else so a
      // member can't probe authorship by hand-crafting the query.
      const authorInclude =
        isAppAdmin && query.authorIds?.length
          ? new Set(query.authorIds)
          : undefined;
      const authorExclude =
        isAppAdmin && query.excludeAuthorIds?.length
          ? new Set(query.excludeAuthorIds)
          : undefined;
      const authorFilterActive =
        authorInclude !== undefined || authorExclude !== undefined;

      const ownedItems = owned
        .map((app) => ({
          source: "owned" as const,
          id: app.id,
          slug: app.slug,
          name: app.name,
          description: app.description,
          scope: app.scope,
          authorId: app.authorId,
          authorName:
            app.authorId !== null
              ? (authorNames.get(app.authorId) ?? null)
              : null,
          viewerRole: viewerRoleOf(app),
          latestVersion: app.latestVersion,
          enabled: app.enabled,
          locked: app.locked,
          teams: teamsByApp.get(app.id) ?? [],
          users: usersByApp.get(app.id) ?? [],
          executionModel: "viewer-scoped" as const,
          cspOrigin: "platform-pinned" as const,
          pinnedAt: ownedPins.get(app.id) ?? null,
          labels: app.labels,
          // The app's own icon (emoji or data URL), so a card can show what the
          // app is instead of the same generic glyph on every row.
          icon: app.icon,
        }))
        .filter((item) => {
          if (query.scope !== undefined && item.scope !== query.scope)
            return false;
          if (!matchesLabelFilter(item.labels, labelFilter)) return false;
          // "All" (no scope) hides oversight-only apps; they surface under
          // Personal → Other users, exactly like the Projects list.
          if (query.scope === undefined && item.viewerRole === "admin")
            return false;
          if (
            authorInclude &&
            !(item.authorId !== null && authorInclude.has(item.authorId))
          )
            return false;
          if (
            authorExclude &&
            item.authorId !== null &&
            authorExclude.has(item.authorId)
          )
            return false;
          return true;
        });

      const externalItems = external
        .map((catalogApp) => ({
          source: "external" as const,
          catalogId: catalogApp.catalogId,
          mcpServerId: catalogApp.mcpServerId,
          scope: catalogApp.scope,
          // The server name as the title, suffixed with "/ <tool>" (short
          // tool name, never the slug prefix) only when the server exposes
          // several UI tools; the tool's own description as the subtitle.
          name: externalAppLabel(catalogApp),
          description: catalogApp.toolDescription,
          resourceUri: catalogApp.resourceUri,
          toolName: catalogApp.toolName,
          // The server's registry icon (emoji or data URL) so the card can
          // show which server the app comes from.
          icon: catalogApp.serverIcon,
          requiresInput: catalogApp.requiresInput,
          executionModel: "server-scoped" as const,
          cspOrigin: "author-declared" as const,
          pinnedAt:
            externalPins.get(
              AppPinModel.externalPinKey({
                mcpServerId: catalogApp.mcpServerId,
                resourceUri: catalogApp.resourceUri,
                toolName: catalogApp.toolName,
              }),
            ) ?? null,
          labels: externalLabels.get(catalogApp.catalogId) ?? [],
        }))
        .filter((item) => {
          if (query.scope !== undefined && item.scope !== query.scope)
            return false;
          if (!matchesLabelFilter(item.labels, labelFilter)) return false;
          // The owner sub-filter targets owned personal apps; external installs
          // have no comparable author and none are oversight-only, so drop them
          // whenever an author filter is active rather than mis-attributing them.
          if (authorFilterActive) return false;
          return true;
        });

      const items: AppListItem[] = [...ownedItems, ...externalItems];
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
    "/api/apps/labels/keys",
    {
      schema: {
        operationId: RouteId.GetAppLabelKeys,
        description: "Get all label keys used by apps",
        tags: ["Apps"],
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ organizationId }, reply) => {
      return reply.send(await AppLabelModel.getAllKeys(organizationId));
    },
  );

  fastify.get(
    "/api/apps/labels/values",
    {
      schema: {
        operationId: RouteId.GetAppLabelValues,
        description: "Get all label values used by apps",
        tags: ["Apps"],
        querystring: z.object({
          key: z.string().optional().describe("Filter values by label key"),
        }),
        response: constructResponseSchema(z.array(z.string())),
      },
    },
    async ({ query: { key }, organizationId }, reply) => {
      return reply.send(
        key
          ? await AppLabelModel.getValuesByKey({ organizationId, key })
          : await AppLabelModel.getAllValues(organizationId),
      );
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
      return reply.send(await getAppTemplates());
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
      // `openInChat` hands the new app straight to a chat agent to build (the
      // Apps page create flow), so that agent is resolved up front: the app
      // binds to its environment below, and the seeded conversation reuses the
      // very same agent rather than resolving one of its own.
      //
      // Best-effort, like the seeding itself — a failure here must not fail the
      // create. It costs the environment inference: the app falls back to the
      // configured landing environment and seeding resolves the agent on its
      // own, exactly as both did before this was inferred at all.
      const builderAgentId = body.openInChat
        ? await resolveDefaultChatAgentId({
            userId: user.id,
            organizationId,
          }).catch((error) => {
            logger.warn(
              { err: error, organizationId },
              "Failed to resolve the chat agent for a new app",
            );
            return null;
          })
        : null;
      const environmentId = await resolveNewAppEnvironmentId({
        userId: user.id,
        organizationId,
        requested: body.environmentId,
        builderAgentId,
      });
      await assertEnvironmentAssignable({
        userId: user.id,
        organizationId,
        environmentId,
      });
      const { html, seededFromTemplate } = await resolveCreateAppHtml({
        html: body.html,
        name: body.name,
      });
      const { payload, warnings } = await buildValidatedVersionPayload({
        html,
        uiPermissions: body.uiPermissions,
      });
      const slug =
        body.slug ??
        (await AppModel.generateUniqueSlug({
          name: body.name,
          organizationId,
        }));
      const lifecycleDefaults =
        await resolveNewAppLifecycleDefaults(organizationId);
      // Names are unique per author and slugs per org; a duplicate of either
      // fails this insert before any backing is created.
      const created = await AppModel.create({
        app: {
          organizationId,
          authorId: user.id,
          name: body.name,
          slug,
          description: body.description ?? null,
          templateId: seededFromTemplate ? DEFAULT_APP_TEMPLATE_ID : null,
          enabled: lifecycleDefaults.enabled,
          locked: lifecycleDefaults.locked,
        },
        payload,
      }).catch((error) => {
        throw appConflictError(error, { name: body.name, slug });
      });
      // An app must never exist without its backing (the catalog owns its
      // visibility + environment); on backing failure delete the app row.
      try {
        await createAppBacking({
          app: created,
          scope,
          environmentId,
          icon: body.icon ?? null,
          userId: user.id,
          organizationId,
          teamIds,
        });
      } catch (error) {
        await AppModel.purge(created.id);
        throw error;
      }
      if (body.labels?.length) {
        await AppLabelModel.syncAppLabels(created.id, body.labels);
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
            // The agent whose environment the app was just bound to, so the
            // chat that builds it runs as that agent (see `builderAgentId`).
            ...(builderAgentId ? { agentId: builderAgentId } : {}),
            creationBuildChat: true,
          }));
          // The Apps page creates a blank app and drops the user straight into
          // this conversation to build it. When an organization default is
          // what locked or disabled the app, that build has to be able to
          // start, so the conversation gets the same creation-time grace
          // `scaffold_app` gives its own (chat carries the conversation id as
          // its session key). Everyone else meets both from the app's first
          // moment.
          if (lifecycleDefaults.locked || !lifecycleDefaults.enabled) {
            await AppModel.setCreationGraceSessionKey(app.id, conversationId);
          }
        } catch (error) {
          logger.warn(
            { err: error, appId: app.id, conversationId },
            "Failed to open the newly created app in chat",
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
    async (request, reply) => {
      const {
        params: { appId },
        user,
        organizationId,
      } = request;
      // The service re-checks app visibility (404s if the caller can't view it).
      const { conversationId } = await createSeededAppConversation({
        appId,
        userId: user.id,
        organizationId,
        // Present only when the client generated a conversation key and sent
        // it — the same header the composer's locked-chat toggle uses. Opening
        // an app is a browser POST, so the key reaches the server on exactly
        // the flow that creates the conversation.
        lockedChat: resolveLockedChatCreationIfRequested(request),
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
    async (request, reply) => {
      const {
        params: { mcpServerId },
        body: { resourceUri },
        user,
        organizationId,
      } = request;
      // The service re-checks install access + that the resource exists (404s
      // otherwise).
      const result = await createSeededExternalAppConversation({
        mcpServerId,
        resourceUri,
        userId: user.id,
        organizationId,
        lockedChat: resolveLockedChatCreationIfRequested(request),
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
          "by install + resource + tool (several tools of one server can share " +
          "a UI resource, so the tool name pins one tile, not the group). " +
          "Personal — does not affect other members.",
        tags: ["Apps"],
        params: z.object({ mcpServerId: UuidIdSchema }),
        body: z.object({
          resourceUri: z.string().min(1),
          toolName: z.string().min(1),
        }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async (
      { params: { mcpServerId }, body: { resourceUri, toolName }, user },
      reply,
    ) => {
      // Same gate as external open-in-chat: the install must be accessible and
      // actually expose this UI resource for this tool (404s otherwise, no
      // existence leak).
      const uiResource = await McpServerModel.findInstalledUiResourceForCaller({
        userId: user.id,
        mcpServerId,
        resourceUri,
        toolName,
      });
      if (!uiResource) {
        throw new ApiError(404, "No runnable app found for this install.");
      }
      await AppPinModel.pinExternal({
        userId: user.id,
        mcpServerId,
        resourceUri,
        toolName,
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
          "user lost access to can still be cleared. `resourceUri` and " +
          "`toolName` ride the query string (DELETE carries no body).",
        tags: ["Apps"],
        params: z.object({ mcpServerId: UuidIdSchema }),
        querystring: z.object({
          resourceUri: z.string().min(1),
          toolName: z.string().min(1),
        }),
        response: constructResponseSchema(z.object({ ok: z.literal(true) })),
      },
    },
    async (
      { params: { mcpServerId }, query: { resourceUri, toolName }, user },
      reply,
    ) => {
      await AppPinModel.unpinExternal({
        userId: user.id,
        mcpServerId,
        resourceUri,
        toolName,
      });
      return reply.send({ ok: true as const });
    },
  );

  fastify.get(
    "/api/apps/:appId",
    {
      schema: {
        operationId: RouteId.GetApp,
        description:
          "Get a single app by id or slug, if the caller may view it.",
        tags: ["Apps"],
        // The only app route that takes a slug: it backs the `/a/<segment>` run
        // page, which has nothing but the URL segment to go on. Every other
        // route — and the runtime and connector especially — stays uuid-keyed.
        params: z.object({ appId: z.string().min(1) }),
        response: constructResponseSchema(AppWithTeamsSchema),
      },
    },
    async ({ params: { appId: idOrSlug }, user, organizationId }, reply) => {
      const appId = await AppModel.resolveIdFromIdOrSlug({
        idOrSlug,
        organizationId,
      });
      if (appId === null) {
        throw new ApiError(404, `No app found with id ${idOrSlug}.`);
      }
      const app = await loadViewableApp({
        appId,
        userId: user.id,
        organizationId,
        addressedAs: idOrSlug,
      });
      return reply.send(
        await buildAppDetail({ app, userId: user.id, organizationId }),
      );
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
      const nextUserIds =
        body.userIds !== undefined
          ? await resolveOrgUsers(body.userIds, organizationId)
          : undefined;

      await assertCallerMayModifyApp({
        userId: user.id,
        organizationId,
        scope: app.scope,
        authorId: app.authorId,
        resourceTeamIds,
      });
      // Changing the html is editing the app itself, not its settings — hold it
      // to the stricter chat-authoring gate so an admin who only sees the app
      // through oversight can retitle/re-scope it but not rewrite its content.
      if (body.html !== undefined) {
        if (app.locked) {
          throw new ApiError(
            409,
            `App "${app.name}" is locked; its content cannot be replaced. Unlock it first.`,
          );
        }
        await assertCallerMayAuthorApp({
          userId: user.id,
          organizationId,
          app: {
            id: app.id,
            scope: app.scope,
            authorId: app.authorId,
            enabled: app.enabled,
          },
          resourceTeamIds,
        });
      }
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
      // Handing an app to named individuals widens who can reach it just as a
      // team change does, so it goes through the same destination check rather
      // than riding along on plain view access.
      if (reScoping || nextTeamIds !== undefined || nextUserIds !== undefined) {
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
        Pick<
          App,
          | "name"
          | "slug"
          | "description"
          | "scope"
          | "environmentId"
          | "icon"
          | "openInFullscreen"
        >
      > = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.slug !== undefined) patch.slug = body.slug;
      if (body.description !== undefined) patch.description = body.description;
      if (body.scope !== undefined) patch.scope = body.scope;
      if (body.environmentId !== undefined)
        patch.environmentId = body.environmentId;
      if (body.icon !== undefined) patch.icon = body.icon;
      if (body.openInFullscreen !== undefined)
        patch.openInFullscreen = body.openInFullscreen;

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
        ...(nextUserIds !== undefined ? { userIds: nextUserIds } : {}),
      }).catch((error) => {
        throw appConflictError(error, { name: body.name, slug: body.slug });
      });
      if (!updated) {
        throw new ApiError(404, `No app found with id ${appId}.`);
      }
      // Labels are replaced wholesale: omitted leaves them unchanged, `[]`
      // clears them. Re-read so the response echoes the persisted set (with its
      // key/value ids) rather than the pre-sync snapshot.
      let result = updated;
      if (body.labels !== undefined) {
        await AppLabelModel.syncAppLabels(appId, body.labels);
        result = (await AppModel.findById(appId)) ?? updated;
      }
      await syncAppBacking(result);
      return reply.send(warnings.length > 0 ? { ...result, warnings } : result);
    },
  );

  fastify.patch(
    "/api/apps/bulk",
    {
      schema: {
        operationId: RouteId.BulkUpdateApps,
        description:
          "Update several apps in one request. Today the only bulk-editable " +
          "surface is visibility — `scope` with the `teamIds` or `userIds` it " +
          "reaches — and every app in the batch is moved to the same one. " +
          "Content is deliberately not editable here: replacing html forks a " +
          "version and is authorized more strictly than re-scoping. Per-app " +
          "problems are reported in `failed` and leave the rest applied.",
        tags: ["Apps"],
        body: z.object({
          ids: BulkIdsSchema,
          scope: AppScopeSchema.describe(
            "The visibility every app in the batch moves to.",
          ),
          teamIds: z
            .array(z.string())
            .optional()
            .describe("Only meaningful for `scope = team`; required there."),
          userIds: z
            .array(z.string())
            .optional()
            .describe(
              "People to share with. Only meaningful for `scope = personal`; " +
                "omitting it revokes existing grants rather than keeping " +
                "them, since this sets one visibility across the selection.",
            ),
        }),
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { user, organizationId, body } = request;
      const { scope } = body;

      // Request-level: the destination is the same for every app, so an
      // unusable one is a bad request rather than N identical failures.
      if (scope === "team" && (body.teamIds ?? []).length === 0) {
        throw new ApiError(
          400,
          "A team-scoped app requires at least one teamId.",
        );
      }
      const teamIds =
        scope === "team"
          ? await resolveOrgTeams(body.teamIds ?? [], organizationId)
          : [];
      const userIds =
        scope === "personal"
          ? await resolveOrgUsers(body.userIds ?? [], organizationId)
          : [];

      const outcome = await runBulk({
        ids: body.ids,
        logLabel: "apps bulk update",
        notFoundMessage: "App not found",
        unexpectedMessage: "Could not update this app",
        // Reuses the single-app loader per id rather than reimplementing app
        // visibility. That costs a query per app; the point of the bulk route
        // is one HTTP round trip and one authorization pass, not one query.
        load: async (ids) => {
          const found = new Map<string, App>();
          for (const appId of ids) {
            const app = await loadViewableApp({
              appId,
              userId: user.id,
              organizationId,
            }).catch(() => null);
            if (app) found.set(appId, app);
          }
          return found;
        },
        describe: (app) => app.name,
        authorize: async (app) => {
          const resourceTeamIds = await AppAccessModel.getTeamsForApp(app.id);
          // Twice, as the single-app update does: the caller must be allowed
          // to modify the app where it is, and to place it where it is going.
          await assertCallerMayModifyApp({
            userId: user.id,
            organizationId,
            scope: app.scope,
            authorId: app.authorId,
            resourceTeamIds,
          });
          await assertCallerMayModifyApp({
            userId: user.id,
            organizationId,
            scope,
            authorId: app.authorId,
            resourceTeamIds: teamIds,
          });
        },
        applyEach: async (app, appId) => {
          const updated = await AppModel.update({
            id: appId,
            patch: { scope },
            teamIds,
            userIds,
          });
          if (!updated) {
            throw new ApiError(404, `No app found with id ${appId}.`);
          }
          await syncAppBacking(updated);
        },
        audit: {
          target: request,
          snapshot: async (ids) => ({
            apps: await AppModel.findVisibilityForBulkAudit({
              ids,
              organizationId,
            }),
          }),
        },
      });

      return reply.send(outcome);
    },
  );

  fastify.delete(
    "/api/apps/bulk",
    {
      schema: {
        operationId: RouteId.BulkDeleteApps,
        description:
          "Soft-delete several apps in one request. Each id is authorized " +
          "exactly as the single-app delete authorizes its own, so an app the " +
          "caller cannot see or administer — and a locked app, which is never " +
          "deletable until unlocked — is reported in `failed` while the rest " +
          "of the batch still applies.",
        tags: ["Apps"],
        body: BulkDeleteBodySchema,
        response: constructResponseSchema(BulkOutcomeSchema),
      },
    },
    async (request, reply) => {
      const { user, organizationId } = request;

      const outcome = await runBulk({
        ids: request.body.ids,
        logLabel: "apps bulk delete",
        notFoundMessage: "App not found",
        unexpectedMessage: "Could not delete this app",
        load: async (ids) => {
          const found = new Map<string, App>();
          for (const appId of ids) {
            const app = await loadViewableApp({
              appId,
              userId: user.id,
              organizationId,
            }).catch(() => null);
            if (app) found.set(appId, app);
          }
          return found;
        },
        describe: (app) => app.name,
        authorize: async (app) => {
          await assertCallerMayModifyApp({
            userId: user.id,
            organizationId,
            scope: app.scope,
            authorId: app.authorId,
            resourceTeamIds: await AppAccessModel.getTeamsForApp(app.id),
          });
          if (app.locked) {
            throw new ApiError(
              409,
              `App "${app.name}" is locked and cannot be deleted. Unlock it first.`,
            );
          }
        },
        applyEach: async (app, appId) => {
          const deleted = await AppModel.delete(appId);
          if (!deleted) {
            throw new ApiError(404, `No app found with id ${appId}.`);
          }
          await deleteAppBacking(app);
        },
        audit: {
          target: request,
          snapshot: async (ids) => ({
            apps: await AppModel.findVisibilityForBulkAudit({
              ids,
              organizationId,
            }),
          }),
        },
      });

      return reply.send(outcome);
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
      if (app.locked) {
        throw new ApiError(
          409,
          `App "${app.name}" is locked and cannot be deleted. Unlock it first.`,
        );
      }
      const success = await AppModel.delete(appId);
      if (!success) {
        throw new ApiError(404, `No app found with id ${appId}.`);
      }
      await deleteAppBacking(app);
      logger.info({ appId, userId: user.id }, "App deleted via REST");
      return reply.send({ success });
    },
  );

  // Enable/disable an app — the enabled/disabled lifecycle. A disabled app is
  // author-only and its launch tool is withheld from every gateway/agent
  // surface; enabling makes it live at its scope, disabling pulls it back to
  // author-only. Kept off the generic PATCH so the transition has its own
  // audit and a stricter, single-purpose authorization.
  for (const action of ["enable", "disable"] as const) {
    const enable = action === "enable";
    fastify.post(
      `/api/apps/:appId/${action}`,
      {
        schema: {
          operationId: enable ? RouteId.EnableApp : RouteId.DisableApp,
          description: enable
            ? "Enable a disabled app, making it live at its scope."
            : "Disable an app, pulling it back to an author-only state.",
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
        await assertCallerMayModifyApp({
          userId: user.id,
          organizationId,
          scope: app.scope,
          authorId: app.authorId,
          resourceTeamIds: await AppAccessModel.getTeamsForApp(app.id),
        });
        const updated = await AppModel.setEnabled(appId, enable);
        if (!updated) {
          throw new ApiError(404, `No app found with id ${appId}.`);
        }
        logger.info(
          { appId, userId: user.id, enabled: enable },
          enable ? "App enabled via REST" : "App disabled via REST",
        );
        return reply.send(
          await buildAppDetail({
            app: updated,
            userId: user.id,
            organizationId,
          }),
        );
      },
    );
  }

  // Lock/unlock an app. The lock freezes the app against modification from
  // chat (every authoring MCP tool refuses, and agents may unlock only on the
  // user's direct request); on REST it additionally refuses the destructive
  // paths — replacing the html and deleting the app — while settings-level
  // metadata edits remain available to authorized users, who hold this toggle.
  for (const action of ["lock", "unlock"] as const) {
    const lock = action === "lock";
    fastify.post(
      `/api/apps/:appId/${action}`,
      {
        schema: {
          operationId: lock ? RouteId.LockApp : RouteId.UnlockApp,
          description: lock
            ? "Lock an app, refusing all chat-driven modification (and REST html replacement/deletion) until unlocked."
            : "Unlock a locked app, making it editable again.",
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
        await assertCallerMayModifyApp({
          userId: user.id,
          organizationId,
          scope: app.scope,
          authorId: app.authorId,
          resourceTeamIds: await AppAccessModel.getTeamsForApp(app.id),
        });
        const updated = await AppModel.setLocked(appId, lock);
        if (!updated) {
          throw new ApiError(404, `No app found with id ${appId}.`);
        }
        logger.info(
          { appId, userId: user.id, locked: lock },
          lock ? "App locked via REST" : "App unlocked via REST",
        );
        return reply.send(
          await buildAppDetail({
            app: updated,
            userId: user.id,
            organizationId,
          }),
        );
      },
    );
  }

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
      if (!isCanonicalBase64(data)) {
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
          result.code === "not_found"
            ? 404
            : result.code === "forbidden"
              ? 403
              : 400,
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
 * Map a write that tripped one of the `apps` unique indexes to the 409 naming
 * the field that actually collided. Both indexes surface the same error class,
 * so they have to be told apart by constraint name — otherwise a taken URL
 * reports as a taken name. Any other error is returned unchanged to rethrow.
 */
function appConflictError(
  error: unknown,
  attempted: { name?: string; slug?: string },
): unknown {
  if (
    attempted.slug !== undefined &&
    isUniqueConstraintError(error, "apps_org_slug_uidx")
  ) {
    return new ApiError(
      409,
      `The URL "${attempted.slug}" is already taken in this organization.`,
    );
  }
  if (
    attempted.name !== undefined &&
    isUniqueConstraintError(error, "apps_org_author_name_uidx")
  ) {
    return new ApiError(
      409,
      `You already have an app named "${attempted.name}".`,
    );
  }
  return error;
}

/** Load an app the caller may view, or throw 404 (no existence leak). */
async function loadViewableApp(params: {
  appId: string;
  userId: string;
  organizationId: string;
  /**
   * What the 404 names, when the caller addressed the app by something other
   * than its id (a slug). Echoing the resolved id would hand a caller who may
   * not view the app the very identifier they could not otherwise obtain.
   */
  addressedAs?: string;
}): Promise<App> {
  const app = await AppModel.findByIdForCaller({
    id: params.appId,
    organizationId: params.organizationId,
    userId: params.userId,
    isAppAdmin: await callerIsAppAdmin(params.userId, params.organizationId),
  });
  if (!app) {
    throw new ApiError(
      404,
      `No app found with id ${params.addressedAs ?? params.appId}.`,
    );
  }
  return app;
}

/**
 * Assemble the single-app detail payload — team assignments, the caller's
 * viewerRole, and the author's display name — shared by GET, enable, and
 * disable so all three return the same shape.
 */
async function buildAppDetail(params: {
  app: App;
  userId: string;
  organizationId: string;
}) {
  const { app, userId, organizationId } = params;
  const usersByApp = await AppAccessModel.getUserDetailsForApps([app.id]);
  const teamsByApp = await AppAccessModel.getTeamDetailsForApps([app.id]);
  const viewerRole = await resolveViewerRole({ app, userId, organizationId });
  const authorName =
    app.authorId !== null
      ? ((await UserModel.getNamesByIds([app.authorId])).get(app.authorId) ??
        null)
      : null;
  return {
    ...app,
    teams: teamsByApp.get(app.id) ?? [],
    users: usersByApp.get(app.id) ?? [],
    viewerRole,
    authorName,
  };
}

/**
 * The caller's relationship to an app they can already view: their own (owner),
 * reached through its scope (shared), or seen only via app:admin oversight
 * (admin). The single-app analogue of the list route's viewerRole labelling.
 */
async function resolveViewerRole(params: {
  app: App;
  userId: string;
  organizationId: string;
}): Promise<AppViewerRole> {
  if (params.app.authorId === params.userId) return "owner";
  const reachableWithoutAdmin = await AppAccessModel.userHasAppAccess({
    organizationId: params.organizationId,
    userId: params.userId,
    app: {
      id: params.app.id,
      organizationId: params.app.organizationId,
      scope: params.app.scope,
      authorId: params.app.authorId,
      enabled: params.app.enabled,
    },
    isAppAdmin: false,
  });
  return reachableWithoutAdmin ? "shared" : "admin";
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
 * Whether an item's labels satisfy a parsed `?labels=` filter: AND across keys
 * (every key must match), OR within a key's values. A null/empty filter matches
 * everything.
 */
function matchesLabelFilter(
  labels: { key: string; value: string }[],
  filter: Record<string, string[]> | undefined,
): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([key, values]) =>
    labels.some((label) => label.key === key && values.includes(label.value)),
  );
}

function isCanonicalBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;

  const canonical = Buffer.from(value, "base64").toString("base64");
  return value === canonical || value === canonical.replace(/=+$/, "");
}

/**
 * Authorize binding an app to `environmentId` (null = org default). Mirrors the
 * agent/knowledge-base/MCP-catalog path: org membership of the environment plus
 * app:deploy-to-restricted are enforced by `assertCanAssignEnvironment`, which
 * also gates a restricted *default* environment.
 */
async function assertEnvironmentAssignable(params: {
  userId: string;
  organizationId: string;
  environmentId: string | null;
}): Promise<void> {
  const { userId, organizationId, environmentId } = params;
  const hasAppDeploy = await userHasPermission(
    userId,
    organizationId,
    "app",
    "deploy-to-restricted",
  );
  await assertCanAssignEnvironment({
    environmentId,
    organizationId,
    canDeployToRestricted: hasAppDeploy,
  });
}

/**
 * The environment a new app binds to. An explicit value in the body wins
 * (including a deliberate null, which means the default environment). Otherwise
 * the app follows the agent that will build it — the chat agent an
 * `openInChat` create hands it to — because that is the environment the agent
 * discovers tools in, so what `search_tools` just found is assignable to the
 * app it is building (the same binding `scaffold_app` makes for an app created
 * from chat). Only when there is no such agent, or its environment is one this
 * caller may not deploy to, does the org's configured landing environment for
 * new apps decide, and then the Default one.
 */
async function resolveNewAppEnvironmentId(params: {
  userId: string;
  organizationId: string;
  requested: string | null | undefined;
  /** The chat agent that will build the app, when the create opens it in chat. */
  builderAgentId: string | null;
}): Promise<string | null> {
  const { userId, organizationId, requested, builderAgentId } = params;
  if (requested !== undefined) return requested;

  const canDeployToRestricted = await userHasPermission(
    userId,
    organizationId,
    "app",
    "deploy-to-restricted",
  );

  if (builderAgentId) {
    const agentEnvironmentId =
      await AgentModel.findEnvironmentId(builderAgentId);
    // A restricted environment the caller may not deploy to falls through to
    // the configured default rather than failing the create — inferring an
    // environment must never turn "New app" into a 403 (choosing that
    // environment explicitly is still refused by assertEnvironmentAssignable).
    if (
      agentEnvironmentId &&
      (await environmentIsAssignable({
        environmentId: agentEnvironmentId,
        organizationId,
        canDeployToRestricted,
      }))
    ) {
      return agentEnvironmentId;
    }
  }

  return resolveDefaultEnvironmentForNewResource({
    organizationId,
    resource: "app",
    canDeployToRestricted,
  });
}

/**
 * The boolean form of {@link assertEnvironmentAssignable}, for an environment
 * this route *inferred* rather than was handed: it falls back instead of
 * failing the request.
 */
async function environmentIsAssignable(params: {
  environmentId: string;
  organizationId: string;
  canDeployToRestricted: boolean;
}): Promise<boolean> {
  try {
    await assertCanAssignEnvironment(params);
    return true;
  } catch (error) {
    if (error instanceof ApiError) return false;
    throw error;
  }
}

export default appRoutes;
