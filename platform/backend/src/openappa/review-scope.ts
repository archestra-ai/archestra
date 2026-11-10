import { z } from "zod";

/** One bullet of what a review's ruling would cover, as the runtime types it. */
export type ReviewScopeItem = z.infer<typeof ReviewScopeItemSchema>;

/**
 * Parses a review's stored scope. `undefined` means unknown, so a caller
 * shows the review text; `[]` means the ruling accepts nothing else. A shape
 * this build does not know is unknown too, never a partial list.
 */
export function parseReviewScope(
  json: string | undefined,
): ReviewScopeItem[] | undefined {
  if (json === undefined) return undefined;
  try {
    const parsed = ReviewScopeSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const tools = z.array(z.string());

const ReviewRequirementSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("trust"), required: z.string() }),
  z.object({ type: z.literal("public_audience") }),
  z.object({ type: z.literal("audience"), readers: z.array(z.string()) }),
  z.object({ type: z.literal("effect"), excludes: z.string() }),
]);

const ReviewNarrowingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("blocked"), tools }),
  z.object({ type: z.literal("sign_off"), tools }),
  z.object({ type: z.literal("recipient_checked"), tools }),
  z.object({ type: z.literal("per_call") }),
  z.object({ type: z.literal("unjudged") }),
]);

const ReviewScopeItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("attention"),
    mark: z.string(),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("requirement"),
    requirement: ReviewRequirementSchema,
    text: z.string(),
  }),
  z.object({
    kind: z.literal("narrowing"),
    narrowing: ReviewNarrowingSchema,
    text: z.string(),
  }),
]);

const ReviewScopeSchema = z.array(ReviewScopeItemSchema);
