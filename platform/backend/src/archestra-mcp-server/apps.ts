import {
  TOOL_CREATE_APP_SHORT_NAME,
  TOOL_DELETE_APP_SHORT_NAME,
  TOOL_LIST_APPS_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_UPDATE_APP_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import logger from "@/logging";
import { AppModel, AppTeamModel, AppVersionModel } from "@/models";
import type { VersionPayload } from "@/models/app-version";
import {
  assertCallerMayModifyApp,
  callerIsAppAdmin,
} from "@/services/apps/app-authorization";
import { buildValidatedVersionPayload } from "@/services/apps/app-ui-policy";
import { ApiError } from "@/types";
import {
  APP_DESCRIPTION_MAX_LENGTH,
  APP_HTML_MAX_BYTES,
  APP_NAME_MAX_LENGTH,
  APP_TEMPLATE_ID_MAX_LENGTH,
  AppScopeSchema,
  AppUiCspSchema,
  AppUiPermissionsSchema,
} from "@/types/app";
import {
  defineArchestraTool,
  defineArchestraTools,
  errorResult,
  structuredSuccessResult,
  successResult,
} from "./helpers";

const htmlField = z
  .string()
  .min(1)
  .refine((value) => Buffer.byteLength(value, "utf8") <= APP_HTML_MAX_BYTES, {
    message: `html exceeds the ${APP_HTML_MAX_BYTES}-byte limit`,
  })
  .describe(
    "The app's complete, self-contained HTML document — inline all CSS/JS (rendered in a sandboxed iframe).",
  );

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
  uiCsp: AppUiCspSchema.optional().describe(
    "Optional CSP allowlist (bare hostnames). Omitted = restrictive default (own origin only).",
  ),
  uiPermissions: AppUiPermissionsSchema.optional().describe(
    "Optional iframe permissions (camera/microphone/geolocation/clipboardWrite).",
  ),
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
  uiCsp: AppUiCspSchema.optional().describe(
    "New CSP allowlist; part of the version envelope, so it requires html too.",
  ),
  uiPermissions: AppUiPermissionsSchema.optional().describe(
    "New iframe permissions; part of the version envelope, so it requires html too.",
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

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_APP_SHORT_NAME,
    title: "Create App",
    description:
      "Build an interactive app — a to-do list, dashboard, form, tracker, game, or any custom UI — from a single self-contained HTML document. Use this whenever the user asks to make, build, or create an app, tool, or interactive UI: author the complete HTML and pass it as html instead of pasting code into the chat reply. When called from the chat UI the app is rendered inline in the conversation automatically; its standalone page is /apps/<id>/run. Defaults to personal scope (owned by the calling user). Returns the created app id and its first version. The app's HTML runs sandboxed and can persist app-scoped state through window.archestra.data.get/set/list/delete (backed by the app_data_* tools; no app id is passed — the store is always the running app's own).",
    schema: CreateAppSchema,
    outputSchema: AppSummaryOutputSchema,
    async handler({ args, context }) {
      if (!context.userId || !context.organizationId) {
        return errorResult("Authentication required to create an app.");
      }

      const scope = args.scope ?? "personal";
      // Team scope needs explicit team assignment, which these chat tools can't
      // express — without it a team app would have zero team rows and be
      // unreachable. Team apps are created via the Apps UI/REST API.
      if (scope === "team") {
        return errorResult(
          "Team-scoped apps must be created via the Apps UI so teams can be assigned. Use personal or org scope here.",
        );
      }
      let payload: VersionPayload;
      try {
        // Creating a shared (org) app needs the matching authority; a plain
        // member may only create personal apps they author.
        await assertCallerMayModifyApp({
          userId: context.userId,
          organizationId: context.organizationId,
          scope,
          authorId: context.userId,
          resourceTeamIds: [],
        });
        payload = buildValidatedVersionPayload({
          html: args.html,
          uiCsp: args.uiCsp,
          uiPermissions: args.uiPermissions,
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
        payload,
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
        `Created app "${app.name}" (${app.id}). Rendered inline when viewed in chat; standalone run page: /apps/${app.id}/run`,
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
    shortName: TOOL_RENDER_APP_SHORT_NAME,
    title: "Render App",
    description:
      "Render an existing app by id, if the caller may view it. Use this when the user asks to open, show, or get back to an app: when called from the chat UI the app is rendered inline in the conversation; its standalone page is /apps/<id>/run.",
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
        isAppAdmin: await callerIsAppAdmin(
          context.userId,
          context.organizationId,
        ),
      });
      if (!app) {
        return errorResult(`No app found with id ${args.appId}.`);
      }
      const summary = {
        id: app.id,
        name: app.name,
        description: app.description,
        scope: app.scope,
        latestVersion: app.latestVersion,
      };
      return structuredSuccessResult(
        summary,
        `${JSON.stringify(summary, null, 2)}\nRendered inline when viewed in chat; standalone run page: /apps/${app.id}/run`,
      );
    },
  }),
  defineArchestraTool({
    shortName: TOOL_UPDATE_APP_SHORT_NAME,
    title: "Update App",
    description:
      "Change an existing app's HTML and/or metadata. Use this when the user asks to fix, tweak, restyle, or extend an app created earlier — pass the full revised HTML, not a diff. Supplying new html forks a new immutable version (suppressed if identical). When called from the chat UI the app's head version is rendered inline in the conversation.",
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
        isAppAdmin: await callerIsAppAdmin(
          context.userId,
          context.organizationId,
        ),
      });
      if (!app) {
        return errorResult(`No app found with id ${args.appId}.`);
      }
      // These chat tools can't assign teams; re-scoping to team is UI/REST-only.
      if (args.scope === "team") {
        return errorResult(
          "Re-scoping an app to a team must be done via the Apps UI so teams can be assigned.",
        );
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

      // CSP/permissions are part of the immutable version envelope, so they can
      // only change together with new html (no silent partial-version merge).
      if (
        args.html === undefined &&
        (args.uiCsp !== undefined || args.uiPermissions !== undefined)
      ) {
        return errorResult(
          "Changing uiCsp or uiPermissions requires supplying html (they are part of the app version).",
        );
      }
      let version: VersionPayload | undefined;
      if (args.html !== undefined) {
        // CSP/permissions are versioned with the html. An omitted field inherits
        // the current head's value (an html-only edit must not silently drop an
        // existing CSP); a supplied field replaces it.
        const head = await AppVersionModel.findByAppAndVersion(
          app.id,
          app.latestVersion,
        );
        try {
          version = buildValidatedVersionPayload({
            html: args.html,
            uiCsp:
              args.uiCsp !== undefined ? args.uiCsp : (head?.uiCsp ?? null),
            uiPermissions:
              args.uiPermissions !== undefined
                ? args.uiPermissions
                : (head?.uiPermissions ?? null),
          });
        } catch (error) {
          if (error instanceof ApiError) return errorResult(error.message);
          throw error;
        }
      }

      let updated: Awaited<ReturnType<typeof AppModel.update>>;
      try {
        updated = await AppModel.update({
          id: args.appId,
          ...(Object.keys(patch).length > 0 ? { patch } : {}),
          ...(version ? { version } : {}),
        });
      } catch (error) {
        if (error instanceof ApiError) return errorResult(error.message);
        throw error;
      }
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
        `Updated app "${updated.name}" (now at version ${updated.latestVersion}). Rendered inline when viewed in chat; standalone run page: /apps/${updated.id}/run`,
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
        isAppAdmin: await callerIsAppAdmin(
          context.userId,
          context.organizationId,
        ),
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
