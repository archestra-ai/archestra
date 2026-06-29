import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const InsertInvitationSchema = createInsertSchema(
  schema.invitationsTable,
);

export const UpdateInvitationSchema = createUpdateSchema(
  schema.invitationsTable,
);

export type UpdateInvitation = z.infer<typeof UpdateInvitationSchema>;
export type InsertInvitation = z.infer<typeof InsertInvitationSchema>;
