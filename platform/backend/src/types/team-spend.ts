import { z } from "zod";

const TeamSpendUsageSchema = z.object({
  requests: z.number(),
  tokens: z.number(),
  billedSpend: z.number(),
  subscriptionValue: z.number(),
  unpricedRequests: z.number(),
});

export const TeamSpendModelSchema = TeamSpendUsageSchema.extend({
  model: z.string(),
  provider: z.string(),
  timeSeries: z.array(TeamSpendUsageSchema.extend({ timestamp: z.string() })),
});

export const TeamSpendPersonSchema = TeamSpendUsageSchema.extend({
  personId: z.string().nullable(),
  personName: z.string(),
  kind: z.enum(["person", "service_account", "unattributed"]),
  timeSeries: z.array(TeamSpendUsageSchema.extend({ timestamp: z.string() })),
});

export const TeamSpendSchema = z.object({
  teamId: z.string(),
  teamName: z.string(),
  parentId: z.string().nullable(),
  memberCount: z.number(),
  directSpend: z.number(),
  descendantSpend: z.number(),
  requests: z.number(),
  tokens: z.number(),
  subscriptionValue: z.number(),
  unpricedRequests: z.number(),
  models: z.array(TeamSpendModelSchema),
  people: z.array(TeamSpendPersonSchema).optional(),
});
export type TeamSpend = z.infer<typeof TeamSpendSchema>;
