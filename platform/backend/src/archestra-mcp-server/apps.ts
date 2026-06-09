import {
  TOOL_CREATE_APP_SHORT_NAME,
  TOOL_DELETE_APP_SHORT_NAME,
  TOOL_GET_APP_SHORT_NAME,
  TOOL_LIST_APPS_SHORT_NAME,
  TOOL_UPDATE_APP_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { requireScopedModifyPermission } from "@/auth/agent-type-permissions";
import { userHasPermission } from "@/auth/utils";
import logger from "@/logging";
import { AppModel, AppTeamModel, TeamModel } from "@/models";
import { ApiError } from "@/types";
import type { AppScope } from "@/types/app";
import {
  APP_DESCRIPTION_MAX_LENGTH,
  APP_HTML_MAX_BYTES,
  APP_NAME_MAX_LENGTH,
  APP_TEMPLATE_ID_MAX_LENGTH,
  AppScopeSchema,
} from "@/types/app";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
  successResult,
} from "./helpers";
import type { ArchestraContext } from "./types";

const htmlField = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= APP_HTML_MAX_BYTES, {
    message: `html exceeds the ${APP_HTML_MAX_BYTES}-byte limit`,
  })
  .describe("The app's HTML document (rendered in a sandboxed iframe).");

const CreateAppSchema = z.strictObject({
  name: z.string().min(1).max(APP_NAME_MAX_LENGTH).describe("App name."),
  description: z
    .string()
    .max(APP_DESCRIPTION_MAX_LENGTH)
    .optional()
    .describe("Optional description."),
  html: htmlField,
  scope: AppScopeSchema.optional().describe(
    "Visibility scope. Defaults to personal (owned by the calling user).",
  ),
  templateId: z
    .string()
    .max(APP_TEMPLATE_ID_MAX_LENGTH)
    .optional()
    .describe("Optional id of the template this app was seeded from."),
});

const ListAppsSchema = z.strictObject({
  name: z.string().optional().describe("Filter by name (substring match)."),
  limit: z.number().int().positive().max(100).optional(),
});

const GetAppSchema = z.strictObject({
  appId: z.string().uuid().describe("The app id."),
});

const UpdateAppSchema = z.strictObject({
  appId: z.string().uuid().describe("The app id."),
  name: z.string().min(1).max(APP_NAME_MAX_LENGTH).optional(),
  description: z.string().max(APP_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  scope: AppScopeSchema.optional(),
  html: htmlField
    .optional()
    .describe(
      "New HTML; supplying it forks a new immutable version (no-op if unchanged).",
    ),
});

const DeleteAppSchema = z.strictObject({
  appId: z.string().uuid().describe("The app id."),
});

const AppSummaryOutputSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  scope: AppScopeSchema,
  latestVersion: z.number(),
});

async function callerIsAppAdmin(context: ArchestraContext): Promise<boolean> {
  if (!context.userId || !context.organizationId) {
    return false;
  }
  return userHasPermission(
    context.userId,
    context.organizationId,
    "app",
    "admin",
  );
}

/**
 * Write authorization (create/update/delete). Visibility (`findByIdForCaller`)
 * is NOT enough to mutate — an org-scoped app is visible to every member but
 * only an admin may change it. Delegates to the shared 3-tier rule used by
 * agents/skills. Throws `ApiError(403)` when denied. `userId`/`organizationId`
 * must be present (handlers check before calling).
 */
async function assertCallerMayModifyApp(params: {
  userId: string;
  organizationId: string;
  scope: AppScope;
  authorId: string | null;
  resourceTeamIds: string[];
}): Promise<void> {
  const [isAdmin, isTeamAdmin, userTeamIds] = await Promise.all([
    userHasPermission(params.userId, params.organizationId, "app", "admin"),
    userHasPermission(
      params.userId,
      params.organizationId,
      "app",
      "team-admin",
    ),
    TeamModel.getUserTeamIds(params.userId),
  ]);
  requireScopedModifyPermission({
    isAdmin,
    isTeamAdmin,
    scope: params.scope,
    authorId: params.authorId,
    resourceTeamIds: params.resourceTeamIds,
    userTeamIds,
    userId: params.userId,
    resourceLabel: "app",
  });
}

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_APP_SHORT_NAME,
    title: "Create App",
    description:
      "Create a new MCP App from an HTML document. Defaults to personal scope (owned by the calling user). Returns the created app id and its first version.",
    schema: CreateAppSchema,
    outputSchema: AppSummaryOutputSchema,
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required to create an app.");
      }

      const scope = args.scope ?? "personal";
      try {
        // Creating a shared (team/org) app needs the matching authority; a plain
        // member may only create personal apps they author.
        await assertCallerMayModifyApp({
          userId: context.userId,
          organizationId: context.organizationId,
          scope,
          authorId: context.userId,
          resourceTeamIds: [],
        });
      } catch (error) {
        if (error instanceof ApiError) return errorResult(error.message);
        throw error;
      }

      const app = await AppModel.create({
        app: {
          organizationId: context.organizationId,
          authorId: context.userId,
          scope,
          name: args.name,
          description: args.description ?? null,
          templateId: args.templateId ?? null,
        },
        payload: { html: args.html, uiCsp: null, uiPermissions: null },
      });

      if (!app) {
        return errorResult(
          `An app named "${args.name}" already exists in this scope.`,
        );
      }

      return structuredSuccessResult(
        {
          id: app.id,
          name: app.name,
          description: app.description,
          scope: app.scope,
          latestVersion: app.latestVersion,
        },
        `Created app "${app.name}" (${app.id}).`,
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_LIST_APPS_SHORT_NAME,
    title: "List Apps",
    description:
      "List apps visible to the caller, optionally filtered by name.",
    schema: ListAppsSchema,
    outputSchema: z.object({ apps: z.array(AppSummaryOutputSchema) }),
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required.");
      }
      const accessibleAppIds = await AppTeamModel.getUserAccessibleAppIds({
        organizationId: context.organizationId,
        userId: context.userId,
      });
      const apps = await AppModel.findByOrganization({
        organizationId: context.organizationId,
        accessibleAppIds,
        ...(args.name ? { search: args.name } : {}),
        limit: Math.min(args.limit ?? 20, 100),
      });
      return structuredSuccessResult({
        apps: apps.map((app) => ({
          id: app.id,
          name: app.name,
          description: app.description,
          scope: app.scope,
          latestVersion: app.latestVersion,
        })),
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_GET_APP_SHORT_NAME,
    title: "Get App",
    description: "Get a single app by id, if the caller may view it.",
    schema: GetAppSchema,
    outputSchema: AppSummaryOutputSchema,
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required.");
      }
      const app = await AppModel.findByIdForCaller({
        id: args.appId,
        organizationId: context.organizationId,
        userId: context.userId,
        isAppAdmin: await callerIsAppAdmin(context),
      });
      if (!app) {
        return errorResult(`No app found with id ${args.appId}.`);
      }
      return structuredSuccessResult({
        id: app.id,
        name: app.name,
        description: app.description,
        scope: app.scope,
        latestVersion: app.latestVersion,
      });
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_APP_SHORT_NAME,
    title: "Update App",
    description:
      "Update an app's metadata and/or its HTML. Supplying new html forks a new immutable version (suppressed if identical).",
    schema: UpdateAppSchema,
    outputSchema: AppSummaryOutputSchema,
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required.");
      }
      const app = await AppModel.findByIdForCaller({
        id: args.appId,
        organizationId: context.organizationId,
        userId: context.userId,
        isAppAdmin: await callerIsAppAdmin(context),
      });
      if (!app) {
        return errorResult(`No app found with id ${args.appId}.`);
      }

      try {
        const resourceTeamIds = await AppTeamModel.getTeamsForApp(app.id);
        // Authority to modify the app as it is today...
        await assertCallerMayModifyApp({
          userId: context.userId,
          organizationId: context.organizationId,
          scope: app.scope,
          authorId: app.authorId,
          resourceTeamIds,
        });
        // ...and, if re-scoping, authority for the destination scope too (so a
        // personal app can't be promoted to org without admin).
        if (args.scope !== undefined && args.scope !== app.scope) {
          await assertCallerMayModifyApp({
            userId: context.userId,
            organizationId: context.organizationId,
            scope: args.scope,
            authorId: app.authorId,
            resourceTeamIds,
          });
        }
      } catch (error) {
        if (error instanceof ApiError) return errorResult(error.message);
        throw error;
      }

      const patch: {
        name?: string;
        description?: string | null;
        scope?: typeof app.scope;
      } = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.description !== undefined) patch.description = args.description;
      if (args.scope !== undefined) patch.scope = args.scope;

      const updated = await AppModel.update({
        id: args.appId,
        ...(Object.keys(patch).length > 0 ? { patch } : {}),
        ...(args.html !== undefined
          ? { version: { html: args.html, uiCsp: null, uiPermissions: null } }
          : {}),
      });
      if (!updated) {
        return errorResult(`Failed to update app ${args.appId}.`);
      }
      return structuredSuccessResult(
        {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          scope: updated.scope,
          latestVersion: updated.latestVersion,
        },
        `Updated app "${updated.name}" (now at version ${updated.latestVersion}).`,
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_DELETE_APP_SHORT_NAME,
    title: "Delete App",
    description: "Soft-delete an app the caller owns or administers.",
    schema: DeleteAppSchema,
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required.");
      }
      const app = await AppModel.findByIdForCaller({
        id: args.appId,
        organizationId: context.organizationId,
        userId: context.userId,
        isAppAdmin: await callerIsAppAdmin(context),
      });
      if (!app) {
        return errorResult(`No app found with id ${args.appId}.`);
      }
      try {
        await assertCallerMayModifyApp({
          userId: context.userId,
          organizationId: context.organizationId,
          scope: app.scope,
          authorId: app.authorId,
          resourceTeamIds: await AppTeamModel.getTeamsForApp(app.id),
        });
      } catch (error) {
        if (error instanceof ApiError) return errorResult(error.message);
        throw error;
      }
      const deleted = await AppModel.delete(args.appId);
      if (!deleted) {
        return errorResult(`Failed to delete app ${args.appId}.`);
      }
      logger.info(
        { appId: args.appId, userId: context.userId },
        "App deleted via Archestra tool",
      );
      return successResult(`Deleted app "${app.name}".`);
    },
  }),
] as const);

export const toolEntries = registry.toolEntries;
export const tools = registry.tools;
