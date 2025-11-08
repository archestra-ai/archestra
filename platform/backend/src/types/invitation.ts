import { createUpdateSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const UpdateInvitationSchema = createUpdateSchema(
  schema.invitationsTable,
);

export type UpdateInvitation = z.infer<typeof UpdateInvitationSchema>;
