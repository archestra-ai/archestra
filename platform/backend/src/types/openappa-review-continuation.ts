import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { A2AProtocolSendMessageResponseSchema } from "@/agents/a2a/a2a-protocol";
import { schema } from "@/database";
import { ReviewOriginSchema } from "@/openappa/review-origin";

export const ReviewContinuationStateSchema = z.enum([
  "queued",
  "resuming",
  "ready",
  "delivering",
  "delivered",
  "failed",
]);
export type ReviewContinuationState = z.infer<
  typeof ReviewContinuationStateSchema
>;
export const ReviewContinuationSchema = createSelectSchema(
  schema.openappaReviewContinuationsTable,
  {
    origin: ReviewOriginSchema,
    state: ReviewContinuationStateSchema,
    result: A2AProtocolSendMessageResponseSchema.nullable(),
  },
);
export type ReviewContinuation = z.infer<typeof ReviewContinuationSchema>;
