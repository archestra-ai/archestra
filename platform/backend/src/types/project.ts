import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/** Who a shared project is visible to (no share row = owner only). */
export const ProjectShareVisibilitySchema = z.enum(["organization", "team"]);
export type ProjectShareVisibility = z.infer<
  typeof ProjectShareVisibilitySchema
>;

export const SelectProjectSchema = createSelectSchema(schema.projectsTable);
export const InsertProjectSchema = createInsertSchema(
  schema.projectsTable,
).omit({
  id: true,
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
  isOwner: z.boolean(),
  conversationCount: z.number().int().nonnegative(),
  /** Share visibility; null = not shared (owner only). */
  visibility: ProjectShareVisibilitySchema.nullable(),
  createdAt: z.date(),
});
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

/** Project detail; share team ids are present for the owner only. */
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
  lastMessageAt: z.date(),
  createdAt: z.date(),
  /** True when the caller is not the chat's author (view-only). */
  readOnly: z.boolean(),
});
export type ProjectConversationItem = z.infer<
  typeof ProjectConversationItemSchema
>;
