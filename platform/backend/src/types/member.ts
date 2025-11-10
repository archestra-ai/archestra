import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const MemberSchema = createSelectSchema(schema.membersTable);
const UpdateMemberSchema = createUpdateSchema(schema.membersTable);
const InsertMemberSchema = createInsertSchema(schema.membersTable);

export type Member = z.infer<typeof MemberSchema>;
export type UpdateMember = z.infer<typeof UpdateMemberSchema>;
export type InsertMember = z.infer<typeof InsertMemberSchema>;
