import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectUserSchema = createSelectSchema(schema.usersTable);

export const UpdateUserOnboardingBodySchema = z.object({
  onboardingCompleted: z.boolean().default(true),
});

export type UpdateUserOnboardingBody = z.infer<
  typeof UpdateUserOnboardingBodySchema
>;
