import type { InferSelectModel } from "drizzle-orm";
import { createSelectSchema } from "drizzle-zod";
import { schema } from "@/database";

export const UserSchema = createSelectSchema(schema.usersTable);
export type User = InferSelectModel<typeof schema.usersTable>;
