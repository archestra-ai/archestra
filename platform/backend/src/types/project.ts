import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { ConversationOriginSchema } from "./conversation";

/** Who a shared project is visible to (no share row = owner only). */
// `user` shares with named individuals listed in `project_share_user`, the
// same option conversations have carried from the start.
export const ProjectShareVisibilitySchema = z.enum([
  "organization",
  "team",
  "user",
]);
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

/**
 * Which lifecycle slice `GET /api/projects` returns: `active` (default) hides
 * soft-deleted projects; `deleted` returns ONLY them — a project:admin-only,
 * org-wide oversight view backing the restore flow.
 */
export const ProjectLifecycleSchema = z.enum(["active", "deleted"]);
export type ProjectLifecycle = z.infer<typeof ProjectLifecycleSchema>;

export const SelectProjectSchema = createSelectSchema(schema.projectsTable);
export const InsertProjectSchema = createInsertSchema(
  schema.projectsTable,
).omit({
  id: true,
  // generated from the name by ProjectModel.create, never caller-supplied.
  slug: true,
  createdAt: true,
  updatedAt: true,
  // soft-delete is ProjectModel.delete's business, never an insert payload.
  deletedAt: true,
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
   * Names of the teams a `team`-shared project is shared with, for the
   * visibility badge. Present (possibly empty) when the caller owns the
   * team-shared project or oversees it via `project:admin`; null otherwise — a
   * plain "shared" recipient doesn't get the full target list (the owner's
   * business), and non-team visibilities have no teams.
   */
  shareTeamNames: z.array(z.string()).nullable(),
  /**
   * Names of the people a `user`-shared project is shared with, for the
   * visibility badge — without them such a project reads as private. Withheld
   * (null) from anyone who cannot manage the project, on the same reasoning as
   * `shareTeamNames`: the full recipient list is the owner's business.
   */
  shareUserNames: z.array(z.string()).nullable(),
  /** When the requesting user pinned this project; null = not pinned. */
  pinnedAt: z.date().nullable(),
  createdAt: z.date(),
  /**
   * When this project was soft-deleted; null for an active project. Non-null
   * only in the project:admin deleted-projects view (`GET /api/projects?status=
   * deleted`), where it drives the "deleted N ago" label.
   */
  deletedAt: z.date().nullable(),
});
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

/**
 * Project detail; share team ids are present for those who can manage the
 * project (owner or `project:admin`), so the edit dialog can populate sharing.
 */
export const ProjectDetailSchema = ProjectListItemSchema.extend({
  shareTeamIds: z.array(z.string()).nullable(),
  // People a `user`-shared project names. Null when the caller cannot
  // manage sharing, matching how shareTeamIds is withheld.
  shareUserIds: z.array(z.string()).nullable(),
  /**
   * The org-wide agent preselected for new chats and scheduled tasks in this
   * project; null = fall through to the organization default. Resolved and
   * re-validated server-side, so a pin whose agent was deleted or rescoped
   * reads as null rather than naming an agent the caller cannot use.
   */
  defaultAgent: z
    .object({ id: z.string().uuid(), name: z.string() })
    .nullable(),
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
  /** The schedule (trigger) + run behind a `schedule_trigger` chat; null for
   * user chats. Used to collapse a schedule's runs into one chat-list row. */
  scheduleTriggerId: z.string().nullable(),
  scheduleRunId: z.string().nullable(),
  /** The schedule's name, shown as the row's subtitle for scheduled chats. */
  scheduleName: z.string().nullable(),
});
export type ProjectConversationItem = z.infer<
  typeof ProjectConversationItemSchema
>;
