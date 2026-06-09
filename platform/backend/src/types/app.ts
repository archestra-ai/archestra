import { ResourceVisibilityScopeSchema } from "@archestra/shared";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { CredentialResolutionModeSchema } from "./enterprise-managed-credentials";

/** Apps share the personal/team/org visibility model of agents and skills. */
export const AppScopeSchema = ResourceVisibilityScopeSchema;
export type AppScope = z.infer<typeof AppScopeSchema>;

// Limits. The html cap is enforced by byte length (not char count) so the
// stored size is bounded regardless of multi-byte content.
export const APP_NAME_MAX_LENGTH = 100;
export const APP_DESCRIPTION_MAX_LENGTH = 500;
export const APP_TEMPLATE_ID_MAX_LENGTH = 100;
export const APP_HTML_MAX_BYTES = 512 * 1024;
/** Per-document size cap for the App Data Store. */
export const APP_DATA_MAX_VALUE_BYTES = 256 * 1024;
/** Max number of keys a single app may persist in its data store. */
export const APP_DATA_MAX_ENTRIES = 1000;
export const APP_DATA_KEY_MAX_LENGTH = 256;

/**
 * Structural validators for the snapshotted CSP/permissions. These check shape
 * only; strict hostname/whitelist validation is layered on at the save path
 * (Component 7), not here, so the column types stay reusable.
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

// drizzle-derived schemas (internal: model layer reads/writes through these).
export const SelectAppSchema = createSelectSchema(schema.appsTable, {
  scope: AppScopeSchema,
});
// `latestVersion` is owned by AppModel (set on create, bumped on fork); omit it
// from external insert payloads alongside the generated/managed columns.
export const InsertAppSchema = createInsertSchema(schema.appsTable, {
  scope: AppScopeSchema.optional(),
}).omit({
  id: true,
  latestVersion: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
});

// uiCsp/uiPermissions are nullable columns (null → host default / no perms), so
// the overrides keep that nullability — a verbatim override would otherwise drop it.
export const SelectAppVersionSchema = createSelectSchema(
  schema.appVersionsTable,
  {
    uiCsp: AppUiCspSchema.nullable(),
    uiPermissions: AppUiPermissionsSchema.nullable(),
  },
);
export const InsertAppVersionSchema = createInsertSchema(
  schema.appVersionsTable,
  {
    uiCsp: AppUiCspSchema.nullable().optional(),
    uiPermissions: AppUiPermissionsSchema.nullable().optional(),
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

export const SelectAppTeamSchema = createSelectSchema(schema.appTeamTable);

// Public payloads (create_app/update_app tools + REST CRUD). HTML and its
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
  templateId: z.string().max(APP_TEMPLATE_ID_MAX_LENGTH).optional(),
  scope: AppScopeSchema.optional(),
  html: htmlField,
  uiCsp: AppUiCspSchema.optional(),
  uiPermissions: AppUiPermissionsSchema.optional(),
});

export const UpdateAppSchema = z.object({
  name: z.string().min(1).max(APP_NAME_MAX_LENGTH).optional(),
  description: z.string().max(APP_DESCRIPTION_MAX_LENGTH).nullable().optional(),
  scope: AppScopeSchema.optional(),
  // Supplying html forks a new immutable version (no-op forks are suppressed).
  html: htmlField.optional(),
  uiCsp: AppUiCspSchema.optional(),
  uiPermissions: AppUiPermissionsSchema.optional(),
});

export type App = z.infer<typeof SelectAppSchema>;
export type InsertApp = z.infer<typeof InsertAppSchema>;
export type AppVersion = z.infer<typeof SelectAppVersionSchema>;
export type InsertAppVersion = z.infer<typeof InsertAppVersionSchema>;
export type AppTool = z.infer<typeof SelectAppToolSchema>;
export type InsertAppTool = z.infer<typeof InsertAppToolSchema>;
export type AppData = z.infer<typeof SelectAppDataSchema>;
export type InsertAppData = z.infer<typeof InsertAppDataSchema>;
export type AppTeam = z.infer<typeof SelectAppTeamSchema>;
export type CreateApp = z.infer<typeof CreateAppSchema>;
export type UpdateApp = z.infer<typeof UpdateAppSchema>;
