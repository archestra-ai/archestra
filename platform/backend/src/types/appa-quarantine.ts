import { z } from "zod";
import { AppaProxyCallStateSchema } from "./appa-proxy-session";

export const AppaQuarantineAcknowledgmentSchema = z.enum([
  "acknowledged",
  "reconciled",
]);
export type AppaQuarantineAcknowledgment = z.infer<
  typeof AppaQuarantineAcknowledgmentSchema
>;

/** Safe operator projection. Correlation identifiers and event bodies stay internal. */
export const AppaQuarantineReviewSchema = z.object({
  id: z.string().uuid(),
  profileId: z.string().uuid(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AppaQuarantineReview = z.infer<typeof AppaQuarantineReviewSchema>;

export const AppaQuarantineActionOutcomeSchema = z
  .enum(["success", "failure", "indeterminate"])
  .nullable();

/** Safe call-ledger summary. Arguments, outputs, and caller IDs stay internal. */
export const AppaQuarantineActionSummarySchema = z.object({
  callRef: z.string().uuid(),
  tool: z.string(),
  state: AppaProxyCallStateSchema,
  outcome: AppaQuarantineActionOutcomeSchema,
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AppaQuarantineActionSummary = z.infer<
  typeof AppaQuarantineActionSummarySchema
>;

export const AppaQuarantineDetailSchema = AppaQuarantineReviewSchema.extend({
  actions: z.array(AppaQuarantineActionSummarySchema).max(100),
});
export type AppaQuarantineDetail = z.infer<typeof AppaQuarantineDetailSchema>;

export const AppaQuarantineAcknowledgmentResultSchema = z.object({
  quarantine: AppaQuarantineReviewSchema,
  acknowledgment: AppaQuarantineAcknowledgmentSchema,
  acknowledgedAt: z.coerce.date(),
});
export type AppaQuarantineAcknowledgmentResult = z.infer<
  typeof AppaQuarantineAcknowledgmentResultSchema
>;
