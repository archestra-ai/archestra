import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectOnboardingSurveySubmissionSchema = createSelectSchema(
  schema.onboardingSurveySubmissionsTable,
);

/**
 * API request body: the survey answers a respondent submits. These are
 * validated here, forwarded to the archestra-website API, and NOT stored
 * locally (only the submission marker is).
 */
export const SubmitOnboardingSurveySchema = z.object({
  role: z.string().min(1).max(200),
  workEnvironment: z.string().min(1).max(200),
  referralSource: z.string().min(1).max(200),
  workEmail: z.string().email().max(320).nullish(),
});

export type OnboardingSurveySubmission = z.infer<
  typeof SelectOnboardingSurveySubmissionSchema
>;
export type SubmitOnboardingSurvey = z.infer<
  typeof SubmitOnboardingSurveySchema
>;
