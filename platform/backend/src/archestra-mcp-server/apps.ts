import {
  TOOL_CREATE_APP_SHORT_NAME,
  TOOL_DELETE_APP_SHORT_NAME,
  TOOL_LIST_APPS_SHORT_NAME,
  TOOL_RENDER_APP_SHORT_NAME,
  TOOL_UPDATE_APP_SHORT_NAME,
} from "@archestra/shared";
import { z } from "zod";
import { getAppTemplates, resolveCreateAppHtml } from "@/app-templates";
import logger from "@/logging";
import { AppModel, AppTeamModel, AppVersionModel } from "@/models";
import type { VersionPayload } from "@/models/app-version";
import {
  replaceAppToolAssignments,
  resolveAppToolsByName,
} from "@/services/agent-tool-assignment";
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

const toolsField = z
  .array(z.string().min(1))
  .max(50)
  .optional()
  .describe(
    "Upstream MCP tool names to assign to the app (e.g. from search_tools), callable from its HTML via archestra.tools.call with the viewing user's credentials. Declarative: the given list replaces the app's current assignments ([] clears them); omitted leaves them unchanged.",
  );

const templateIds = getAppTemplates()
  .map((t) => t.id)
  .join(", ");

const CreateAppSchema = z.strictObject({
  name: z.string().min(1).max(APP_NAME_MAX_LENGTH).describe("App name."),
  description: z
    .string()
    .max(APP_DESCRIPTION_MAX_LENGTH)
    .optional()
    .describe("Optional description."),
  html: htmlField
    .optional()
    .describe(
      "The app's complete, self-contained HTML document — inline all CSS/JS (rendered in a sandboxed iframe). Omit it to scaffold from templateId instead.",
    ),
  scope: AppScopeSchema.optional().describe(
    "Visibility scope. Defaults to personal (owned by the calling user).",
  ),
  templateId: z
    .string()
    .max(APP_TEMPLATE_ID_MAX_LENGTH)
    .optional()
    .describe(
      `Template to scaffold from when html is omitted (one of: ${templateIds}); the result returns the seeded HTML for editing. With html present it is recorded as provenance only.`,
    ),
  uiCsp: AppUiCspSchema.optional().describe(
    "Optional CSP allowlist (bare hostnames). Omitted = restrictive default (own origin only).",
  ),
  uiPermissions: AppUiPermissionsSchema.optional().describe(
    "Optional iframe permissions (camera/microphone/geolocation/clipboardWrite).",
  ),
  tools: toolsField,
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
  tools: toolsField,
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
  warnings: z
    .array(z.string())
    .optional()
    .describe(
      "Soft save-time validation warnings about the html (the save succeeded); fix them via update_app.",
    ),
});

// create/update additionally echo the assignment set when `tools` was given
const AppMutationOutputSchema = AppSummaryOutputSchema.extend({
  tools: z
    .array(z.string())
    .optional()
    .describe(
      "The app's assigned tool names after this call (present when the tools param was given).",
    ),
});

const registry = defineArchestraTools([
  defineArchestraTool({
    shortName: TOOL_CREATE_APP_SHORT_NAME,
    title: "Create App",
    description: `Build an interactive app — a to-do list, dashboard, form, tracker, game, or any custom UI — from a single self-contained HTML document. Use this whenever the user asks to make, build, or create an app, tool, or interactive UI: author the complete HTML and pass it as html — do not paste the code into the chat reply or write it as an artifact (artifact_write is for markdown documents, not apps). Author PURE UI HTML against the Archestra Apps SDK the platform injects at render time as window.archestra: archestra.user is the authenticated viewer ({id, name} — no login flow needed); archestra.storage.user.get/set/list/delete persists state private to each viewer (favorites, drafts, settings — the right default) and archestra.storage.shared.* is one store all users of the app share (no app id is passed; the store is always the running app's own); archestra.tools.call(name, args) calls the app's assigned tools as the viewing user, with their existing MCP credentials, and throws {code: "auth_required", url} when the tool's server still needs connecting (render that url as a link); archestra.tools.list() returns the assigned tools; archestra.ui.openLink(url), archestra.ui.requestDisplayMode(mode) and archestra.chat.sendMessage(text) reach the host; await archestra.ready before the first call. TOOL-FIRST RULE: when the app needs data from an external service (search, APIs, SaaS), first look for an installed MCP tool (search_tools), assign it via the tools param, and call it with archestra.tools.call — do NOT hand-roll fetch() calls to external APIs (they run unauthenticated and need CSP domains); raw fetch + uiCsp connectDomains is the fallback only when no tool exists. Do NOT import SDKs, read __ARCHESTRA_APP_SDK_URL__, or wire postMessage yourself — that glue is provided and hand-rolling it breaks the app. Alternatively omit html and pass templateId (one of: ${templateIds}) to scaffold from a curated starter; the result includes the seeded HTML so you can update_app it. When called from the chat UI the app is rendered inline in the conversation automatically; its standalone page is /apps/<id>/run. Defaults to personal scope (owned by the calling user). Returns the created app id and its first version.`,
    schema: CreateAppSchema,
    outputSchema: AppMutationOutputSchema,
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
      let warnings: string[];
      let seededFromTemplate: boolean;
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
        const resolved = resolveCreateAppHtml({
          html: args.html,
          templateId: args.templateId,
        });
        seededFromTemplate = resolved.seededFromTemplate;
        const validated = buildValidatedVersionPayload({
          html: resolved.html,
          uiCsp: args.uiCsp,
          uiPermissions: args.uiPermissions,
        });
        payload = validated.payload;
        warnings = validated.warnings;
      } catch (error) {
        if (error instanceof ApiError) return errorResult(error.message);
        throw error;
      }

      // Resolve the tools list BEFORE creating the app, so a bad list never
      // leaves a half-built app behind.
      const toolsResolution = await resolveToolsParam({
        organizationId: context.organizationId,
        tools: args.tools,
      });
      if (!toolsResolution.ok) return errorResult(toolsResolution.error);
      const resolvedTools = toolsResolution.tools;

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

      if (resolvedTools !== undefined && resolvedTools.length > 0) {
        try {
          await replaceAppToolAssignments(app.id, resolvedTools);
        } catch (error) {
          // Prevalidation makes this a rare race (e.g. a tool deleted
          // concurrently). The app exists; tell the model how to repair.
          logger.warn(
            { err: error, appId: app.id },
            "create_app: tool assignment failed after creation",
          );
          return errorResult(
            `Created app "${app.name}" (${app.id}), but assigning its tools failed. Retry via update_app with the tools param.`,
          );
        }
      }

      // Scaffold-then-edit: when the template seeded the html, return it so
      // the model can immediately update_app without a read-back round-trip.
      const seededHtmlNote = seededFromTemplate
        ? `\nSeeded from template "${args.templateId}"; current HTML (edit via update_app):\n${payload.html}`
        : "";
      const warningsNote =
        warnings.length > 0
          ? `\nValidation warnings (save succeeded; fix via update_app):\n- ${warnings.join("\n- ")}`
          : "";
      const toolsParts = toolsResultParts(resolvedTools);
      return structuredSuccessResult(
        {
          id: app.id,
          name: app.name,
          description: app.description,
          scope: app.scope,
          latestVersion: app.latestVersion,
          ...toolsParts.structured,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
        `Created app "${app.name}" (${app.id}). Rendered inline when viewed in chat; standalone run page: /apps/${app.id}/run${toolsParts.note}${warningsNote}${seededHtmlNote}`,
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
      "Change an existing app's HTML, assigned tools, and/or metadata. Use this when the user asks to fix, tweak, restyle, or extend an app created earlier — pass the full revised HTML, not a diff. Author pure UI HTML against the injected Apps SDK (window.archestra: archestra.user identity, archestra.storage.user/.shared persistence, archestra.tools.call for assigned tools as the viewing user, archestra.ui.*/archestra.chat.*) — never add SDK imports or postMessage wiring. Prefer assigned MCP tools (tools param + archestra.tools.call) over hand-rolled fetch() to external APIs. Supplying new html forks a new immutable version (suppressed if identical); tools replaces the assignment list declaratively. When called from the chat UI the app's head version is rendered inline in the conversation. If a rendered app threw runtime errors, they arrive as an <app-render-diagnostics> block on the user's next message — use them to correct the HTML here.",
    schema: UpdateAppSchema,
    outputSchema: AppMutationOutputSchema,
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

      // Resolve the tools list before any mutation, so a bad list fails the
      // whole update instead of landing a partial one. [] clears assignments.
      const toolsResolution = await resolveToolsParam({
        organizationId: context.organizationId,
        tools: args.tools,
      });
      if (!toolsResolution.ok) return errorResult(toolsResolution.error);
      const resolvedTools = toolsResolution.tools;

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
      let warnings: string[] = [];
      if (args.html !== undefined) {
        // CSP/permissions are versioned with the html. An omitted field inherits
        // the current head's value (an html-only edit must not silently drop an
        // existing CSP); a supplied field replaces it.
        const head = await AppVersionModel.findByAppAndVersion(
          app.id,
          app.latestVersion,
        );
        try {
          const validated = buildValidatedVersionPayload({
            html: args.html,
            uiCsp:
              args.uiCsp !== undefined ? args.uiCsp : (head?.uiCsp ?? null),
            uiPermissions:
              args.uiPermissions !== undefined
                ? args.uiPermissions
                : (head?.uiPermissions ?? null),
          });
          version = validated.payload;
          warnings = validated.warnings;
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

      if (resolvedTools !== undefined) {
        try {
          await replaceAppToolAssignments(updated.id, resolvedTools);
        } catch (error) {
          // Prevalidation makes this a rare race; the metadata/html change
          // above already persisted, so be explicit about the partial state.
          logger.warn(
            { err: error, appId: updated.id },
            "update_app: tool assignment failed after update",
          );
          return errorResult(
            `Updated app "${updated.name}", but replacing its tools failed. Retry via update_app with the tools param.`,
          );
        }
      }

      const warningsNote =
        warnings.length > 0
          ? `\nValidation warnings (save succeeded; fix via update_app):\n- ${warnings.join("\n- ")}`
          : "";
      const toolsParts = toolsResultParts(resolvedTools);
      return structuredSuccessResult(
        {
          id: updated.id,
          name: updated.name,
          description: updated.description,
          scope: updated.scope,
          latestVersion: updated.latestVersion,
          ...toolsParts.structured,
          ...(warnings.length > 0 ? { warnings } : {}),
        },
        `Updated app "${updated.name}" (now at version ${updated.latestVersion}). Rendered inline when viewed in chat; standalone run page: /apps/${updated.id}/run${toolsParts.note}${warningsNote}`,
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

// =============================================================================
// Internal helpers
// =============================================================================

type ResolvedTools = Array<{ id: string; name: string }>;

/**
 * Resolve the declarative `tools` param shared by create_app/update_app —
 * before any mutation, so a bad list fails the whole call. `undefined` means
 * "leave assignments untouched"; `[]` clears them.
 */
async function resolveToolsParam(params: {
  organizationId: string;
  tools: string[] | undefined;
}): Promise<
  { ok: true; tools: ResolvedTools | undefined } | { ok: false; error: string }
> {
  if (params.tools === undefined) return { ok: true, tools: undefined };
  const resolution = await resolveAppToolsByName({
    organizationId: params.organizationId,
    toolNames: params.tools,
  });
  if ("error" in resolution) {
    return { ok: false, error: resolution.error.message };
  }
  return { ok: true, tools: resolution.tools };
}

/** Result-text note + structured-output fragment echoing the assignment set. */
function toolsResultParts(resolvedTools: ResolvedTools | undefined): {
  note: string;
  structured: { tools?: string[] };
} {
  if (resolvedTools === undefined) return { note: "", structured: {} };
  const names = resolvedTools.map((tool) => tool.name);
  return {
    note:
      names.length > 0
        ? `\nAssigned tools (callable via archestra.tools.call): ${names.join(", ")}`
        : "\nAssigned tools: none (cleared)",
    structured: { tools: names },
  };
}
