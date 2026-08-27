import {
  PLUGIN_MARKETPLACE_IMPORT_LIMIT,
  ResourceVisibilityScopeSchema,
  RouteId,
} from "@archestra/shared";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { PluginModel, PluginTeamModel, TaskModel } from "@/models";
import {
  importPluginFromGithub,
  normalizeGithubPluginRepoUrl,
  PluginImportError,
} from "@/plugins/github-import";
import {
  discoverGithubMarketplace,
  MarketplaceDiscoveryError,
} from "@/plugins/github-marketplace";
import {
  GithubMarketplaceChangedError,
  prepareGithubMarketplaceImports,
} from "@/plugins/github-marketplace-import";
import { validatePluginVisibility } from "@/services/plugin-visibility";
import {
  resolveGithubAppInstallationToken,
  resolveGithubPatToken,
} from "@/skills/github-app-token";
import { taskQueueService } from "@/task-queue";
import {
  ApiError,
  ClientTypeSchema,
  CreatePluginSchema,
  constructResponseSchema,
  DeleteObjectResponseSchema,
  PluginGithubSyncIntervalSchema,
  PluginListItemSchema,
  PluginPlatformSchema,
  PluginWithFilesSchema,
  UpdatePluginSchema,
  UuidIdSchema,
} from "@/types";
import { isUniqueConstraintError } from "@/utils/db";

const PluginParamsSchema = z.object({ id: UuidIdSchema });

const githubAuthShape = {
  githubToken: z.string().min(1).optional(),
  githubAppConfigId: z.string().uuid().optional(),
  githubPatId: z.string().uuid().optional(),
};

const GithubAuthSchema = z.object(githubAuthShape).refine(hasSingleGithubAuth, {
  message: "Choose only one GitHub authentication method",
});

const GithubCommitShaSchema = z
  .string()
  .regex(/^[a-f0-9]{40}$/i, "Expected a full 40-character Git commit SHA");

const GithubPluginSourceSchema = z
  .object({
    repoUrl: z.string().trim().min(1),
    ref: z.string().trim().min(1).nullable().optional(),
    subdir: z.string().trim().default(""),
    exclude: z.array(z.string().trim().min(1)).max(50).default([]),
    ...githubAuthShape,
  })
  .refine(hasSingleGithubAuth, {
    message: "Choose only one GitHub authentication method",
  });

const GithubPluginPreviewSchema = z.object({
  repo: z.string(),
  requestedRef: z.string().nullable(),
  commitSha: z.string(),
  subdir: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      content: z.string(),
      encoding: z.enum(["utf8", "base64"]),
      mode: z.enum(["100644", "100755"]),
    }),
  ),
  skippedFiles: z.array(z.string()),
});

const MarketplacePathSchema = z.enum([
  ".claude-plugin/marketplace.json",
  ".github/plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
  ".cursor-plugin/marketplace.json",
  "marketplace.json",
]);

const GithubMarketplaceEntrySchema = z.object({
  marketplacePath: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string(),
  clientType: ClientTypeSchema.nullable(),
  sourceRepoUrl: z.string().nullable(),
  sourceRef: z.string().nullable(),
  sourceSubdir: z.string(),
  sourceCommitSha: z.string().nullable(),
  fileCount: z.number().int().nonnegative(),
  supported: z.boolean(),
  reason: z.string().nullable(),
});

const GithubMarketplaceDiscoverySchema = z.object({
  repoUrl: z.string(),
  ref: z.string().nullable(),
  commitSha: z.string(),
  marketplacePath: z.string().nullable(),
  entries: z.array(GithubMarketplaceEntrySchema),
  reason: z.string().nullable(),
});

const GithubMarketplaceSourceSchema = z
  .object({
    repoUrl: z.string().trim().min(1),
    ref: z.string().trim().min(1).nullable().optional(),
    marketplacePath: MarketplacePathSchema.optional(),
    ...githubAuthShape,
  })
  .refine(hasSingleGithubAuth, {
    message: "Choose only one GitHub authentication method",
  });

const MarketplaceImportSelectionSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().trim().min(1).max(120),
  description: z.string().max(1_000).default(""),
  clientType: ClientTypeSchema,
  supportedPlatforms: z.array(PluginPlatformSchema).min(1),
  sourceRepoUrl: z.string().min(1),
  sourceRef: z.string().nullable(),
  sourceSubdir: z.string(),
  approvedSourceSha: GithubCommitShaSchema,
  exclude: z.array(z.string().trim().min(1)).max(50).default([]),
});

const GithubMarketplaceImportSchema = GithubMarketplaceSourceSchema.and(
  z.object({
    marketplacePath: MarketplacePathSchema,
    approvedCommitSha: GithubCommitShaSchema,
    trackingRef: z.string().trim().min(1).nullable(),
    selected: z
      .array(MarketplaceImportSelectionSchema)
      .min(1)
      .max(
        PLUGIN_MARKETPLACE_IMPORT_LIMIT,
        `Select at most ${PLUGIN_MARKETPLACE_IMPORT_LIMIT} plugins per import`,
      ),
    scope: ResourceVisibilityScopeSchema.default("personal"),
    teamIds: z.array(z.string().min(1)).max(100).default([]),
    userIds: z.array(z.string().min(1)).max(100).default([]),
    syncInterval: z
      .union([PluginGithubSyncIntervalSchema, z.null()])
      .default("1d"),
  }),
);

const pluginRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.addHook("onRequest", async () => {
    if (!config.plugins.enabled) {
      throw new ApiError(404, "Plugins are not enabled");
    }
  });

  fastify.get(
    "/api/plugins",
    {
      schema: {
        operationId: RouteId.GetPlugins,
        description: "List plugins for the organization",
        tags: ["Plugins"],
        response: constructResponseSchema(z.array(PluginListItemSchema)),
      },
    },
    async ({ organizationId, user }, reply) => {
      const isAdmin = await userHasPermission(
        user.id,
        organizationId,
        "plugin",
        "admin",
      );
      const accessiblePluginIds = isAdmin
        ? undefined
        : await PluginTeamModel.getUserAccessiblePluginIds({
            organizationId,
            userId: user.id,
          });
      const plugins = await PluginModel.findByOrganization({
        organizationId,
        accessiblePluginIds,
      });
      return reply.send(plugins);
    },
  );

  fastify.post(
    "/api/plugins/github/marketplace/discover",
    {
      schema: {
        operationId: RouteId.DiscoverGithubPluginMarketplace,
        description:
          "Discover and normalize plugins advertised by a GitHub marketplace repository",
        tags: ["Plugins"],
        body: GithubMarketplaceSourceSchema,
        response: constructResponseSchema(GithubMarketplaceDiscoverySchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user, body } = request;
      await requirePluginAdmin({ organizationId, userId: user.id });
      const githubToken = await resolveGithubToken({
        ...body,
        organizationId,
        userId: user.id,
      });
      const discovery = await runMarketplaceDiscovery(() =>
        discoverGithubMarketplace({
          repoUrl: body.repoUrl,
          ref: body.ref,
          marketplacePath: body.marketplacePath,
          githubToken,
        }),
      );
      reply.header("Cache-Control", "no-store");
      return reply.send(discovery);
    },
  );

  fastify.post(
    "/api/plugins/github/marketplace/import",
    {
      schema: {
        operationId: RouteId.ImportGithubPluginMarketplace,
        description:
          "Import selected plugins from one reviewed GitHub marketplace snapshot",
        tags: ["Plugins"],
        body: GithubMarketplaceImportSchema,
        response: constructResponseSchema(
          z.object({
            created: z.array(PluginWithFilesSchema),
            failed: z.array(z.object({ name: z.string(), error: z.string() })),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { organizationId, user, body } = request;
      await requirePluginAdmin({ organizationId, userId: user.id });
      await validatePluginVisibility({
        organizationId,
        scope: body.scope,
        teamIds: body.teamIds,
        userIds: body.userIds,
      });
      const githubToken = await resolveGithubToken({
        ...body,
        organizationId,
        userId: user.id,
      });
      let preparedBatch: Awaited<
        ReturnType<typeof prepareGithubMarketplaceImports>
      >;
      try {
        preparedBatch = await runMarketplaceDiscovery(() =>
          prepareGithubMarketplaceImports({
            repoUrl: body.repoUrl,
            ref: body.ref,
            marketplacePath: body.marketplacePath,
            approvedCommitSha: body.approvedCommitSha,
            trackingRef: body.trackingRef,
            selections: body.selected,
            githubToken,
          }),
        );
      } catch (error) {
        if (error instanceof GithubMarketplaceChangedError) {
          throw new ApiError(409, error.message);
        }
        throw error;
      }
      const created = [];
      const failed = [...preparedBatch.failed];
      for (const { selection, imported } of preparedBatch.prepared) {
        try {
          const plugin = await PluginModel.create({
            organizationId,
            userId: user.id,
            input: {
              displayName: selection.displayName,
              description: selection.description,
              clientType: selection.clientType,
              supportedPlatforms: selection.supportedPlatforms,
              scope: body.scope,
              teamIds: body.teamIds,
              userIds: body.userIds,
              files: imported.files,
            },
            source: {
              repo: imported.repo,
              ref: selection.sourceRef,
              sha: imported.commitSha,
              subdir: imported.subdir,
              exclude: selection.exclude,
              marketplaceRepo: preparedBatch.marketplace.repoUrl,
              marketplacePath: preparedBatch.marketplace.path,
              marketplacePluginName: selection.name,
              syncInterval: body.syncInterval,
              syncRef: selection.sourceRef,
              githubAppConfigId: body.githubAppConfigId,
              githubPatId: body.githubPatId,
            },
          });
          if (!plugin) throw new Error("Plugin identity already exists");
          created.push(plugin);
        } catch (error) {
          failed.push({
            name: selection.name,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      request.auditAfter = {
        created: created.map((plugin) => ({
          id: plugin.id,
          displayName: plugin.displayName,
          sourceSha: plugin.sourceSha,
        })),
        failed,
      };
      return reply.send({ created, failed });
    },
  );

  fastify.post(
    "/api/plugins/github/preview",
    {
      schema: {
        operationId: RouteId.PreviewGithubPlugin,
        description:
          "Resolve a GitHub ref and preview the exact by-value plugin bytes",
        tags: ["Plugins"],
        body: GithubPluginSourceSchema,
        response: constructResponseSchema(GithubPluginPreviewSchema),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      await requirePluginAdmin({ organizationId, userId: user.id });
      const githubToken = await resolveGithubToken({
        ...body,
        organizationId,
        userId: user.id,
      });
      const imported = await runGithubImport(() =>
        importPluginFromGithub({
          repoUrl: body.repoUrl,
          ref: body.ref,
          trackingRef: body.ref,
          subdir: body.subdir,
          exclude: body.exclude,
          githubToken,
        }),
      );
      return reply.send(imported);
    },
  );

  fastify.post(
    "/api/plugins/github/import",
    {
      schema: {
        operationId: RouteId.ImportGithubPlugin,
        description:
          "Import and approve a plugin from an immutable GitHub commit",
        tags: ["Plugins"],
        body: GithubPluginSourceSchema.and(
          z.object({
            displayName: z.string().trim().min(1).max(120),
            description: z.string().max(1_000).default(""),
            clientType: ClientTypeSchema,
            supportedPlatforms: z.array(PluginPlatformSchema).min(1).optional(),
            scope: ResourceVisibilityScopeSchema.optional(),
            teamIds: z.array(z.string().min(1)).max(100).optional(),
            userIds: z.array(z.string().min(1)).max(100).optional(),
            approvedCommitSha: GithubCommitShaSchema,
            trackingRef: z.string().trim().min(1).nullable().optional(),
          }),
        ),
        response: constructResponseSchema(PluginWithFilesSchema),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      await requirePluginAdmin({ organizationId, userId: user.id });
      const githubToken = await resolveGithubToken({
        ...body,
        organizationId,
        userId: user.id,
      });
      const imported = await runGithubImport(() =>
        importPluginFromGithub({
          repoUrl: body.repoUrl,
          ref: body.approvedCommitSha,
          trackingRef: body.trackingRef ?? body.ref,
          subdir: body.subdir,
          exclude: body.exclude,
          githubToken,
        }),
      );
      assertApprovedCommit(imported.commitSha, body.approvedCommitSha);
      await validatePluginVisibility({
        organizationId,
        scope: body.scope ?? "personal",
        teamIds: body.teamIds ?? [],
        userIds: body.userIds ?? [],
      });
      const plugin = await PluginModel.create({
        organizationId,
        userId: user.id,
        input: {
          displayName: body.displayName,
          description: body.description,
          clientType: body.clientType,
          supportedPlatforms: body.supportedPlatforms,
          scope: body.scope,
          teamIds: body.teamIds,
          userIds: body.userIds,
          files: imported.files,
        },
        source: {
          repo: imported.repo,
          ref: body.trackingRef ?? body.ref ?? imported.requestedRef ?? null,
          sha: imported.commitSha,
          subdir: imported.subdir,
          exclude: body.exclude,
        },
      });
      if (!plugin) {
        throw new ApiError(409, "A plugin with this plugin identity exists");
      }
      return reply.send(plugin);
    },
  );

  fastify.post(
    "/api/plugins/:id/github/preview-update",
    {
      schema: {
        operationId: RouteId.PreviewGithubPluginUpdate,
        description:
          "Preview the latest tracked GitHub commit without changing approved bytes",
        tags: ["Plugins"],
        params: PluginParamsSchema,
        body: GithubAuthSchema.optional(),
        response: constructResponseSchema(GithubPluginPreviewSchema),
      },
    },
    async (request, reply) => {
      const { organizationId, user, params, body } = request;
      await requirePluginAdmin({ organizationId, userId: user.id });
      const githubToken = await resolveGithubToken({
        ...(body ?? {}),
        organizationId,
        userId: user.id,
      });
      const { syncState: observed, imported } =
        await importExistingGithubPlugin({
          id: params.id,
          organizationId,
          userId: user.id,
          githubToken,
        });
      if (imported.commitSha !== observed.sourceSha) {
        const written = await PluginModel.markGithubSyncResult({
          id: observed.id,
          expectedSyncGeneration: observed.syncGeneration,
          expectedPendingSourceSha: observed.pendingSourceSha,
          sourceSha: imported.commitSha,
          files: imported.files,
          error: null,
        });
        if (!written) {
          throw new ApiError(409, "Plugin sync state changed; preview again");
        }
      } else {
        request.auditSkip = true;
      }
      return reply.send(imported);
    },
  );

  fastify.post(
    "/api/plugins/:id/github/apply-update",
    {
      schema: {
        operationId: RouteId.ApplyGithubPluginUpdate,
        description:
          "Re-fetch and explicitly approve the latest tracked GitHub commit",
        tags: ["Plugins"],
        params: PluginParamsSchema,
        body: GithubAuthSchema.and(
          z.object({ approvedCommitSha: GithubCommitShaSchema }),
        ),
        response: constructResponseSchema(PluginWithFilesSchema),
      },
    },
    async ({ organizationId, user, params, body }, reply) => {
      await requirePluginAdmin({ organizationId, userId: user.id });
      const internal = await PluginModel.findByIdForSync(params.id);
      if (
        !internal ||
        internal.organizationId !== organizationId ||
        !internal.pendingSourceSha ||
        internal.pendingSourceSha.toLowerCase() !==
          body.approvedCommitSha.toLowerCase()
      ) {
        throw new ApiError(
          409,
          "The approved commit must match the current pending update candidate",
        );
      }
      const githubToken = await resolveGithubToken({
        ...body,
        organizationId,
        userId: user.id,
      });
      const { imported } = await importExistingGithubPlugin({
        id: params.id,
        organizationId,
        userId: user.id,
        approvedCommitSha: body.approvedCommitSha,
        githubToken,
      });
      const plugin = await PluginModel.applyGithubUpdate({
        id: params.id,
        organizationId,
        userId: user.id,
        expectedPendingSha: imported.commitSha,
        files: imported.files,
      });
      if (!plugin) {
        throw new ApiError(
          409,
          "The pending update candidate changed; review it again",
        );
      }
      return reply.send(plugin);
    },
  );

  fastify.patch(
    "/api/plugins/:id/github/sync",
    {
      schema: {
        operationId: RouteId.UpdatePluginGithubSync,
        description: "Change or pause a Plugin GitHub sync schedule",
        tags: ["Plugins"],
        params: PluginParamsSchema,
        body: z.object({
          interval: z.union([PluginGithubSyncIntervalSchema, z.null()]),
        }),
        response: constructResponseSchema(PluginWithFilesSchema),
      },
    },
    async ({ organizationId, user, params, body }, reply) => {
      await requirePluginAdmin({ organizationId, userId: user.id });
      const existing = await PluginModel.findById({
        id: params.id,
        organizationId,
      });
      if (!existing) throw new ApiError(404, "Plugin not found");
      if (body.interval !== null && existing.sourceKind !== "github") {
        throw new ApiError(400, "Only GitHub-sourced plugins can be synced");
      }
      await PluginModel.setGithubSync({
        id: existing.id,
        interval: body.interval,
      });
      const plugin = await PluginModel.findById({
        id: existing.id,
        organizationId,
      });
      if (!plugin) throw new ApiError(404, "Plugin not found");
      return reply.send(plugin);
    },
  );

  fastify.post(
    "/api/plugins/:id/github/check",
    {
      schema: {
        operationId: RouteId.TriggerPluginGithubSync,
        description: "Queue an immediate Plugin GitHub source check",
        tags: ["Plugins"],
        params: PluginParamsSchema,
        response: constructResponseSchema(z.object({ queued: z.boolean() })),
      },
    },
    async (request, reply) => {
      const { organizationId, user, params } = request;
      await requirePluginAdmin({ organizationId, userId: user.id });
      const plugin = await PluginModel.findById({
        id: params.id,
        organizationId,
      });
      if (!plugin) throw new ApiError(404, "Plugin not found");
      if (plugin.sourceKind !== "github" || !plugin.sourceRepo) {
        throw new ApiError(400, "Plugin is not connected to a GitHub source");
      }
      const active = await TaskModel.findActivePayloadValues(
        "plugin_github_sync",
        "pluginId",
      );
      if (active.has(plugin.id)) {
        request.auditAfter = { pluginId: plugin.id, queued: false };
        return reply.send({ queued: false });
      }
      try {
        await taskQueueService.enqueue({
          taskType: "plugin_github_sync",
          payload: { pluginId: plugin.id, force: true },
        });
        request.auditAfter = { pluginId: plugin.id, queued: true };
        return reply.send({ queued: true });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          request.auditAfter = { pluginId: plugin.id, queued: false };
          return reply.send({ queued: false });
        }
        throw error;
      }
    },
  );

  fastify.post(
    "/api/plugins",
    {
      schema: {
        operationId: RouteId.CreatePlugin,
        description:
          "Create a plugin. Hook configuration bytes are stored verbatim.",
        tags: ["Plugins"],
        body: CreatePluginSchema,
        response: constructResponseSchema(PluginWithFilesSchema),
      },
    },
    async ({ organizationId, user, body }, reply) => {
      await requirePluginAdmin({ organizationId, userId: user.id });
      await validatePluginVisibility({
        organizationId,
        scope: body.scope ?? "personal",
        teamIds: body.teamIds ?? [],
        userIds: body.userIds ?? [],
      });
      const plugin = await PluginModel.create({
        organizationId,
        userId: user.id,
        input: body,
      });
      if (!plugin) {
        throw new ApiError(409, "A plugin with this plugin identity exists");
      }
      return reply.send(plugin);
    },
  );

  fastify.get(
    "/api/plugins/:id",
    {
      schema: {
        operationId: RouteId.GetPlugin,
        description: "Get one plugin and its opaque files",
        tags: ["Plugins"],
        params: PluginParamsSchema,
        response: constructResponseSchema(PluginWithFilesSchema),
      },
    },
    async ({ organizationId, user, params }, reply) => {
      await requirePluginAdmin({ organizationId, userId: user.id });
      const plugin = await PluginModel.findById({
        id: params.id,
        organizationId,
      });
      if (!plugin) throw new ApiError(404, "Plugin not found");
      return reply.send(plugin);
    },
  );

  fastify.put(
    "/api/plugins/:id",
    {
      schema: {
        operationId: RouteId.UpdatePlugin,
        description:
          "Update plugin metadata, visibility, GitHub source settings, or files",
        tags: ["Plugins"],
        params: PluginParamsSchema,
        body: UpdatePluginSchema,
        response: constructResponseSchema(PluginWithFilesSchema),
      },
    },
    async ({ organizationId, user, params, body }, reply) => {
      await requirePluginAdmin({ organizationId, userId: user.id });
      const existing = await PluginModel.findById({
        id: params.id,
        organizationId,
      });
      if (!existing) throw new ApiError(404, "Plugin not found");
      if (body.files && existing.sourceKind === "github") {
        throw new ApiError(
          409,
          "GitHub-sourced plugin files are read-only; preview and approve a source update instead",
        );
      }
      if (body.githubSource && existing.sourceKind !== "github") {
        throw new ApiError(
          409,
          "Only GitHub-sourced plugins have GitHub source settings",
        );
      }
      const githubSource = body.githubSource;
      if (githubSource?.authentication) {
        await resolveGithubToken({
          githubAppConfigId:
            githubSource.authentication.githubAppConfigId ?? undefined,
          githubPatId: githubSource.authentication.githubPatId ?? undefined,
          organizationId,
          userId: user.id,
        });
      }
      const input = githubSource
        ? {
            ...body,
            githubSource: {
              ...githubSource,
              repoUrl: await runGithubImport(async () =>
                normalizeGithubPluginRepoUrl(githubSource.repoUrl),
              ),
            },
          }
        : body;
      await validatePluginVisibility({
        organizationId,
        scope: body.scope ?? existing.scope,
        teamIds: body.teamIds ?? existing.teams.map((team) => team.id),
        userIds: body.userIds ?? existing.users.map((member) => member.id),
      });
      const plugin = await PluginModel.update({
        id: params.id,
        organizationId,
        userId: user.id,
        input,
      });
      if (!plugin) throw new ApiError(404, "Plugin not found");
      return reply.send(plugin);
    },
  );

  fastify.delete(
    "/api/plugins/:id",
    {
      schema: {
        operationId: RouteId.DeletePlugin,
        description: "Delete a plugin",
        tags: ["Plugins"],
        params: PluginParamsSchema,
        response: constructResponseSchema(DeleteObjectResponseSchema),
      },
    },
    async ({ organizationId, user, params }, reply) => {
      await requirePluginAdmin({ organizationId, userId: user.id });
      const existing = await PluginModel.findById({
        id: params.id,
        organizationId,
      });
      if (!existing) throw new ApiError(404, "Plugin not found");
      const plugin = await PluginModel.delete({
        id: params.id,
        organizationId,
      });
      if (!plugin) throw new ApiError(404, "Plugin not found");
      return reply.send({ success: true });
    },
  );
};

export default pluginRoutes;

// === Internal helpers ===

async function resolveGithubToken(params: {
  githubToken?: string;
  githubAppConfigId?: string;
  githubPatId?: string;
  organizationId: string;
  userId: string;
}): Promise<string | undefined> {
  if (!params.githubAppConfigId && !params.githubPatId) {
    return params.githubToken;
  }
  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "githubAppConfig",
    "read",
  );
  if (!allowed) {
    throw new ApiError(403, "You do not have access to GitHub credentials");
  }
  if (params.githubPatId) {
    return resolveGithubPatToken({
      githubPatId: params.githubPatId,
      organizationId: params.organizationId,
    });
  }
  return resolveGithubAppInstallationToken({
    githubAppConfigId: params.githubAppConfigId as string,
    organizationId: params.organizationId,
  });
}

async function requirePluginAdmin(params: {
  organizationId: string;
  userId: string;
}): Promise<void> {
  const allowed = await userHasPermission(
    params.userId,
    params.organizationId,
    "plugin",
    "admin",
  );
  if (!allowed) {
    throw new ApiError(
      403,
      "You need plugin:admin permission to approve executable plugins",
    );
  }
}

async function runGithubImport<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PluginImportError) {
      throw new ApiError(400, error.message);
    }
    throw error;
  }
}

async function runMarketplaceDiscovery<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MarketplaceDiscoveryError) {
      throw new ApiError(400, error.message);
    }
    throw error;
  }
}

async function importExistingGithubPlugin(params: {
  id: string;
  organizationId: string;
  userId: string;
  approvedCommitSha?: string;
  githubToken?: string;
}) {
  const [plugin, syncState] = await Promise.all([
    PluginModel.findById(params),
    PluginModel.findByIdForSync(params.id),
  ]);
  if (
    !plugin ||
    !syncState ||
    syncState.organizationId !== params.organizationId
  ) {
    throw new ApiError(404, "Plugin not found");
  }
  if (plugin.sourceKind !== "github" || !plugin.sourceRepo) {
    throw new ApiError(409, "Plugin is not linked to a GitHub source");
  }
  if (!params.githubToken && (plugin.githubPatId || plugin.githubAppConfigId)) {
    const allowed = await userHasPermission(
      params.userId,
      params.organizationId,
      "githubAppConfig",
      "read",
    );
    if (!allowed) {
      throw new ApiError(403, "You do not have access to GitHub credentials");
    }
  }
  const githubToken =
    params.githubToken ??
    (plugin.githubPatId
      ? await resolveGithubPatToken({
          githubPatId: plugin.githubPatId,
          organizationId: plugin.organizationId,
        })
      : plugin.githubAppConfigId
        ? await resolveGithubAppInstallationToken({
            githubAppConfigId: plugin.githubAppConfigId,
            organizationId: plugin.organizationId,
          })
        : undefined);
  const imported = await runGithubImport(() =>
    importPluginFromGithub({
      repoUrl: plugin.sourceRepo as string,
      ref:
        params.approvedCommitSha ??
        plugin.pendingSourceSha ??
        syncState.githubSyncRef ??
        plugin.sourceRef,
      subdir: plugin.sourceSubdir ?? "",
      exclude: plugin.sourceExclude,
      githubToken,
    }),
  );
  if (params.approvedCommitSha) {
    assertApprovedCommit(imported.commitSha, params.approvedCommitSha);
  }
  return { plugin, syncState, imported };
}

function hasSingleGithubAuth(value: {
  githubToken?: string;
  githubAppConfigId?: string;
  githubPatId?: string;
}): boolean {
  return (
    [value.githubToken, value.githubAppConfigId, value.githubPatId].filter(
      Boolean,
    ).length <= 1
  );
}

function assertApprovedCommit(actual: string, approved: string): void {
  if (actual.toLowerCase() !== approved.toLowerCase()) {
    throw new ApiError(
      409,
      "GitHub resolved a different commit than the one reviewed; preview again",
    );
  }
}
