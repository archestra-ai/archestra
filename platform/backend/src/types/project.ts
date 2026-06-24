import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { ConversationOriginSchema } from "./conversation";

/** Who a shared project is visible to (no share row = owner only). */
export const ProjectShareVisibilitySchema = z.enum(["organization", "team"]);
export type ProjectShareVisibility = z.infer<
  typeof ProjectShareVisibilitySchema
>;

/**
 * The caller's relationship to a project, derived from their real access path:
 * - `owner`  — they own it (full control).
 * - `shared` — reachable via an org/team share (read + collaborate, no manage).
 * - `admin`  — reachable only because they hold `project:admin`; read + manage the
 *   project, but not start chats / create or run-now its schedules.
 */
export const ProjectViewerRoleSchema = z.enum(["owner", "shared", "admin"]);
export type ProjectViewerRole = z.infer<typeof ProjectViewerRoleSchema>;

/**
 * Projects-list scope filter, mirroring the Agents page. A project's "scope" is
 * its share visibility — mutually exclusive like an agent's:
 * - `personal` — private (no share),
 * - `team`     — shared with teams (`visibility=team`; narrow with `teamIds`),
 * - `org`      — shared org-wide (`visibility=organization`).
 * Omitted = all the caller can see. Admins additionally filter `personal` by
 * owner via `authorIds` / `excludeAuthorIds` (the "My / Other users" sub-filter).
 */
export const ProjectListScopeSchema = z.enum(["personal", "team", "org"]);
export type ProjectListScope = z.infer<typeof ProjectListScopeSchema>;

export const SelectProjectSchema = createSelectSchema(schema.projectsTable);
export const InsertProjectSchema = createInsertSchema(
  schema.projectsTable,
).omit({
  id: true,
  // generated from the name by ProjectModel.create, never caller-supplied.
  slug: true,
  createdAt: true,
  updatedAt: true,
});
export type Project = z.infer<typeof SelectProjectSchema>;
export type InsertProject = z.infer<typeof InsertProjectSchema>;

export const SelectProjectShareSchema = createSelectSchema(
  schema.projectSharesTable,
  { visibility: ProjectShareVisibilitySchema },
);
export type ProjectShare = z.infer<typeof SelectProjectShareSchema>;

/** One row of the projects list as the UI renders it. */
export const ProjectListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  /** Emoji or base64 image data URL; null = use the default project icon. */
  icon: z.string().nullable(),
  /** The caller's relationship to this project (drives the UI's capabilities). */
  viewerRole: ProjectViewerRoleSchema,
  /** Display name of the project's owner; null if it can't be resolved. */
  ownerName: z.string().nullable(),
  conversationCount: z.number().int().nonnegative(),
  /** Share visibility; null = not shared (owner only). */
  visibility: ProjectShareVisibilitySchema.nullable(),
  /**
   * Names of the teams a `team`-shared project is shared with, for the owner's
   * visibility badge. Present (possibly empty) only when the caller owns a
   * team-shared project; null otherwise (the share's targets are the owner's
   * business, and other visibilities have no teams).
   */
  shareTeamNames: z.array(z.string()).nullable(),
  /** When the requesting user pinned this project; null = not pinned. */
  pinnedAt: z.date().nullable(),
  createdAt: z.date(),
});
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

/**
 * Project detail; share team ids are present for those who can manage the
 * project (owner or `project:admin`), so the edit dialog can populate sharing.
 */
export const ProjectDetailSchema = ProjectListItemSchema.extend({
  shareTeamIds: z.array(z.string()).nullable(),
});
export type ProjectDetail = z.infer<typeof ProjectDetailSchema>;

/** One chat row in a project's conversation listing. */
export const ProjectConversationItemSchema = z.object({
  id: z.string().uuid(),
  title: z.string().nullable(),
  authorUserId: z.string(),
  authorName: z.string().nullable(),
  /** `schedule_trigger` marks a chat created by a scheduled run. */
  origin: ConversationOriginSchema,
  lastMessageAt: z.date(),
  createdAt: z.date(),
  /** True when the caller is not the chat's author (view-only). */
  readOnly: z.boolean(),
});
export type ProjectConversationItem = z.infer<
  typeof ProjectConversationItemSchema
>;
