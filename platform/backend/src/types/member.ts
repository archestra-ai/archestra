import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const MemberSchema = createSelectSchema(schema.membersTable);

export const MemberListItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  image: z.string().nullable(),
  role: z.string(),
  createdAt: z.date(),
});

const UpdateMemberSchema = createUpdateSchema(schema.membersTable);
const InsertMemberSchema = createInsertSchema(schema.membersTable);

export type Member = z.infer<typeof MemberSchema>;
export type MemberListItem = z.infer<typeof MemberListItemSchema>;
export type UpdateMember = z.infer<typeof UpdateMemberSchema>;
export type InsertMember = z.infer<typeof InsertMemberSchema>;
