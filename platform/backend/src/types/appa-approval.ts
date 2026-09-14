import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const AppaApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "denied",
  "expired",
  "cancelled",
]);
export type AppaApprovalStatus = z.infer<typeof AppaApprovalStatusSchema>;

export const SelectAppaApprovalSchema = createSelectSchema(
  schema.appaProxyApprovalsTable,
  {
    status: AppaApprovalStatusSchema,
  },
);
export type AppaApproval = z.infer<typeof SelectAppaApprovalSchema>;
export type AppaApprovalForTurn = AppaApproval & {
  args: Record<string, unknown>;
};

/** The reviewer-safe projection: normalized arguments come from the call ledger. */
export const AppaApprovalReviewSchema = z.object({
  id: z.string().uuid(),
  candidateCallId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  argumentsSha256: z.string(),
  status: AppaApprovalStatusSchema,
  expiresAt: z.coerce.date(),
  approverId: z.string().nullable(),
  decidedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
});
export type AppaApprovalReview = z.infer<typeof AppaApprovalReviewSchema>;
