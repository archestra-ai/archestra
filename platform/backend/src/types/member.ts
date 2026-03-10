import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const MemberSchema = createSelectSchema(schema.membersTable);
const UpdateMemberSchema = createUpdateSchema(schema.membersTable);
const InsertMemberSchema = createInsertSchema(schema.membersTable);

export type Member = z.infer<typeof MemberSchema>;
export type UpdateMember = z.infer<typeof UpdateMemberSchema>;
export type InsertMember = z.infer<typeof InsertMemberSchema>;

export const MemberWithUserSchema = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string().nullable(),
  email: z.string(),
  role: z.string(),
  createdAt: z.coerce.date(),
  teams: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    }),
  ),
  isPendingSignup: z.boolean(),
});
export type MemberWithUser = z.infer<typeof MemberWithUserSchema>;
