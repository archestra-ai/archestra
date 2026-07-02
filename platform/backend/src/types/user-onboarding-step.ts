import { createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectUserOnboardingStepSchema = createSelectSchema(
  schema.userOnboardingStepsTable,
);

export type UserOnboardingStep = z.infer<typeof SelectUserOnboardingStepSchema>;
