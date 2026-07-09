import { ResourceVisibilityScopeSchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AppRenderDiagnosticEntrySchema } from "./app-diagnostics";
import { AppSpecSchema } from "./app-spec";
import { CredentialResolutionModeSchema } from "./enterprise-managed-credentials";

/** Apps share the personal/team/org visibility model of agents and skills. */
export const AppScopeSchema = ResourceVisibilityScopeSchema;
export type AppScope = z.infer<typeof AppScopeSchema>;

// The launch tool that hands a host the app's `ui://` resource so it renders the
// app. ext-apps hosts discover a renderable UI from a tool's
// `_meta.ui.resourceUri`, so an external client needs a tool to call. Shared by
// BOTH the serve-time synthesized tool (the app server's own tools/list) and the
// persisted catalog `tool` row (prefixed `<app>__open` when assigned to a
// gateway), so the two never diverge. Always offered to a viewer who already
// passed the app's visibility check, so it sits outside the per-tool RBAC filter.
export const APP_LAUNCH_TOOL_NAME = "open";

// Limits. The html cap is enforced by byte length (not char count) so the
// stored size is bounded regardless of multi-byte content.
export const APP_NAME_MAX_LENGTH = 100;
export const APP_DESCRIPTION_MAX_LENGTH = 500;
export const APP_HTML_MAX_BYTES = 512 * 1024;
/** Per-document size cap for the App Data Store. */
export const APP_DATA_MAX_VALUE_BYTES = 256 * 1024;
/** Max number of keys a single app may persist in its data store. */
export const APP_DATA_MAX_ENTRIES = 1000;
export const APP_DATA_KEY_MAX_LENGTH = 256;

/**
 * Shape of the platform-pinned CSP (APP_PLATFORM_CSP) and the snapshotted
 * permissions column. These check shape only; strict hostname/whitelist
 * validation is layered on at the save path, not here.
 */
export const AppUiCspSchema = z
  .object({
    connectDomains: z.array(z.string()).optional(),
    resourceDomains: z.array(z.string()).optional(),
    frameDomains: z.array(z.string()).optional(),
    baseUriDomains: z.array(z.string()).optional(),
  })
  .strict();
export type AppUiCsp = z.infer<typeof AppUiCspSchema>;

export const AppUiPermissionsSchema = z
  .object({
    camera: z.object({}).optional(),
    microphone: z.object({}).optional(),
    geolocation: z.object({}).optional(),
    clipboardWrite: z.object({}).optional(),
  })
  .strict();
export type AppUiPermissions = z.infer<typeof AppUiPermissionsSchema>;

/**
 * Unified Apps-surface listing item. The Apps page lists owned apps and
 * external UI-providing installed MCP servers as one entity, distinguished by
 * `source`. `executionModel` and `cspOrigin` are the machine-readable trust
 * disclosure (mcp-apps.md FR-29): owned apps run as the viewer under the
 * platform-pinned CSP; external apps run server-scoped under the server's own
 * declared CSP. `GET /api/apps/:appId` still returns {@link SelectAppSchema}.
 */
const AppListItemBaseSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  executionModel: z.enum(["viewer-scoped", "server-scoped"]),
  cspOrigin: z.enum(["platform-pinned", "author-declared"]),
  /** When the requesting user pinned this app; null = not pinned. */
  pinnedAt: z.date().nullable(),
});

export const OwnedAppListItemSchema = AppListItemBaseSchema.extend({
  source: z.literal("owned"),
  id: z.string(),
  scope: AppScopeSchema,
  authorId: z.string().nullable(),
  latestVersion: z.number().int(),
  // Teams the app is shared with (via its backing catalog), for the card's
  // visibility pill. Empty unless the app is team-scoped.
  teams: z.array(z.object({ id: z.string(), name: z.string() })),
});

// An external item is one UI-providing tool of one *install* of an MCP server.
// A catalog may expose several `ui://` resources and the caller may have several
// accessible installs (personal/team/org), so the listing yields one item per
// `(mcpServerId, resourceUri)` — installs are surfaced separately, each carrying
// the concrete `mcpServerId` to open in chat and its `scope`. Catalogs with no
// accessible install are omitted entirely (every listed item is runnable). To
// reuse the owned-app card shape, `name` is `"<server> / <tool>"` (the catalog
// display name and the short tool name, e.g. "Archestra PM / show_board" — never
// the slug prefix) and `description` is the tool's own description.
export const ExternalAppListItemSchema = AppListItemBaseSchema.extend({
  source: z.literal("external"),
  catalogId: z.string(),
  mcpServerId: z.string(),
  scope: AppScopeSchema,
  resourceUri: z.string(),
  // The catalog's icon, exactly as the MCP registry renders it: an emoji
  // character or a base64 image data URL. Null when the server has none (the
  // card falls back to its generic server glyph).
  icon: z.string().nullable(),
});

export const AppListItemSchema = z.discriminatedUnion("source", [
  OwnedAppListItemSchema,
  ExternalAppListItemSchema,
]);
export type AppListItem = z.infer<typeof AppListItemSchema>;
export type ExternalAppListItem = z.infer<typeof ExternalAppListItemSchema>;

/** One of the caller's accessible installs of an external app's catalog. */
export const ExternalAppInstallSchema = z.object({
  mcpServerId: z.string(),
  scope: AppScopeSchema,
  ownerId: z.string().nullable(),
  teamId: z.string().nullable(),
  name: z.string(),
  localInstallationStatus: z.string().nullable(),
});
export type ExternalAppInstall = z.infer<typeof ExternalAppInstallSchema>;

/** One UI-providing resource of an external app's catalog (a server may have several). */
export const ExternalAppResourceSchema = z.object({
  resourceUri: z.string(),
  toolName: z.string(),
  // Card/header label: "${serverName} / ${toolName}".
  name: z.string(),
});
export type ExternalAppResource = z.infer<typeof ExternalAppResourceSchema>;

/**
 * Run-page resolution for an external app: the catalog's UI resources plus the
 * caller's accessible installs and the default install (personal → team → org,
 * mcp-apps.md FR-31). `resourceUri` is the default resource; `resources` lists
 * all of them so the run page can validate `?resource=`. `defaultMcpServerId` is
 * null when no install is accessible.
 */
export const ExternalAppResolutionSchema = z.object({
  catalogId: z.string(),
  // The catalog (server) display name; the run page composes per-resource labels.
  name: z.string(),
  description: z.string().nullable(),
  resourceUri: z.string(),
  resources: z.array(ExternalAppResourceSchema),
  defaultMcpServerId: z.string().nullable(),
  installs: z.array(ExternalAppInstallSchema),
});
export type ExternalAppResolution = z.infer<typeof ExternalAppResolutionSchema>;

// drizzle-derived schemas (internal: model layer reads/writes through these).
// Visibility (`scope`) and `environmentId` are NOT app columns — they live on
// the app's backing catalog (FR-30) and are populated by AppModel on read, so
// the App type carries them as derived fields the rest of the code keeps using.
export const SelectAppSchema = createSelectSchema(schema.appsTable, {
  spec: AppSpecSchema.nullable(),
}).extend({
  scope: AppScopeSchema,
  environmentId: z.string().uuid().nullable(),
});
// `latestVersion` is owned by AppModel (set on create, bumped on fork); omit it
// from external insert payloads alongside the generated/managed columns.
export const InsertAppSchema = createInsertSchema(schema.appsTable, {
  spec: AppSpecSchema.nullable().optional(),
}).omit({
  id: true,
  latestVersion: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

// uiPermissions is a nullable column (null → no perms), so the override keeps
// that nullability — a verbatim override would otherwise drop it.
export const SelectAppVersionSchema = createSelectSchema(
  schema.appVersionsTable,
  {
    uiPermissions: AppUiPermissionsSchema.nullable(),
    spec: AppSpecSchema.nullable(),
  },
);
export const InsertAppVersionSchema = createInsertSchema(
  schema.appVersionsTable,
  {
    uiPermissions: AppUiPermissionsSchema.nullable().optional(),
    spec: AppSpecSchema.nullable().optional(),
  },
).omit({ id: true, createdAt: true });

export const SelectAppToolSchema = createSelectSchema(schema.appToolsTable, {
  credentialResolutionMode: CredentialResolutionModeSchema,
});
export const InsertAppToolSchema = createInsertSchema(schema.appToolsTable, {
  credentialResolutionMode: CredentialResolutionModeSchema.optional(),
}).omit({ id: true, createdAt: true, updatedAt: true });

export const SelectAppDataSchema = createSelectSchema(schema.appDataTable);
export const InsertAppDataSchema = createInsertSchema(schema.appDataTable).omit(
  {
    id: true,
    createdAt: true,
    updatedAt: true,
  },
);

export const SelectAppRenderDiagnosticsSchema = createSelectSchema(
  schema.appRenderDiagnosticsTable,
  { entries: z.array(AppRenderDiagnosticEntrySchema) },
);

export const SelectAppRenderScreenshotSchema = createSelectSchema(
  schema.appRenderScreenshotTable,
);

// Public payloads (REST CRUD + the scaffold_app MCP tool). HTML and its
// security envelope live in app_versions, so these are hand-authored composites
// rather than table inserts.
const htmlField = z
  .string()
  .min(1)
  .refine((s) => Buffer.byteLength(s, "utf8") <= APP_HTML_MAX_BYTES, {
    message: `html exceeds ${APP_HTML_MAX_BYTES} bytes`,
  });

export const CreateAppSchema = z.object({
  name: z.string().min(1).max(APP_NAME_MAX_LENGTH),
  description: z.string().max(APP_DESCRIPTION_MAX_LENGTH).optional(),
  scope: AppScopeSchema.optional(),
  // html is optional: supply it to seed explicitly, otherwise the single
  // default template seeds the first version (resolveCreateAppHtml).
  html: htmlField.optional(),
  uiPermissions: AppUiPermissionsSchema.optional(),
  // Environment binding. null/omitted = org default. Org membership and the
  // restricted-env permission are enforced in the route via
  // assertCanAssignEnvironment.
  environmentId: z.string().uuid().nullable().optional(),
});

// Input for the `scaffold_app` MCP tool: it always seeds the single default
// template (no html), so the staged authoring flow is scaffold → edit_app.
// strictObject so apps.ts can extend it with the tool-assignment `tools` param.
export const ScaffoldAppSchema = z.strictObject({
  name: z.string().min(1).max(APP_NAME_MAX_LENGTH).describe("App name."),
  description: z
    .string()
    .max(APP_DESCRIPTION_MAX_LENGTH)
    .optional()
    .describe("Optional description."),
  scope: AppScopeSchema.optional().describe(
    "Visibility scope, personal (default, owned by the calling user) or org. Team scope is not available here — team-scoped apps must be created in the Apps UI so teams can be assigned.",
  ),
  uiPermissions: AppUiPermissionsSchema.optional().describe(
    "Optional iframe permissions (camera/microphone/geolocation/clipboardWrite).",
  ),
});

// Input for the `refine_app` MCP tool: the step between scaffold and edit. It
// clarifies what an app should be — optionally asking the user model-authored
// questions, and/or persisting a consolidated product spec on the app head.
export const RefineAppToolSchema = z.strictObject({
  appId: z.string().uuid().describe("The app id to refine."),
  questions: z
    .array(
      z.strictObject({
        id: z
          .string()
          .min(1)
          .describe("Stable key the answer is returned under."),
        prompt: z.string().min(1).describe("The question shown to the user."),
        options: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            'When present, the question is single-select over these plain-string option labels, e.g. ["Light", "Dark"] — never {label, value} objects; otherwise it is free-text.',
          ),
      }),
    )
    .max(3)
    .optional()
    .describe(
      "Up to 3 clarifying questions to ask the user before consolidating the spec.",
    ),
  spec: AppSpecSchema.optional().describe(
    "The consolidated product requirements to persist on the app (features/data/ui/tools — no implementation stack).",
  ),
});

// A curated starter an app can be seeded from. Shipped as static backend
// modules (see app-templates/); html is the full MCP App document.
export const AppTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  html: z.string(),
});

export const UpdateAppSchema = z.object({
  name: z.string().min(1).max(APP_NAME_MAX_LENGTH).optional(),
  description: z.string().max(APP_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  scope: AppScopeSchema.optional(),
  // Supplying html forks a new immutable version (no-op forks are suppressed).
  html: htmlField.optional(),
  uiPermissions: AppUiPermissionsSchema.optional(),
  // Re-bind the app's environment. null = org default. Existing tool
  // assignments are not stripped on re-bind; out-of-environment ones are refused
  // at call time instead.
  environmentId: z.string().uuid().nullable().optional(),
});

export type { AppSpec } from "./app-spec";
export { AppSpecSchema } from "./app-spec";

export type App = z.infer<typeof SelectAppSchema>;
export type InsertApp = z.infer<typeof InsertAppSchema>;
export type AppVersion = z.infer<typeof SelectAppVersionSchema>;
export type InsertAppVersion = z.infer<typeof InsertAppVersionSchema>;
export type AppTool = z.infer<typeof SelectAppToolSchema>;
export type InsertAppTool = z.infer<typeof InsertAppToolSchema>;
export type AppData = z.infer<typeof SelectAppDataSchema>;
export type InsertAppData = z.infer<typeof InsertAppDataSchema>;
export type CreateApp = z.infer<typeof CreateAppSchema>;
export type UpdateApp = z.infer<typeof UpdateAppSchema>;
export type AppTemplate = z.infer<typeof AppTemplateSchema>;
export type AppRenderDiagnostics = z.infer<
  typeof SelectAppRenderDiagnosticsSchema
>;
export type AppRenderScreenshot = z.infer<
  typeof SelectAppRenderScreenshotSchema
>;
