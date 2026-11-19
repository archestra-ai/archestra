import {
  CostExportFormatSchema,
  CostExportScheduleSchema,
} from "@archestra/shared";
import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database/schema";

export const CostExportRunStatusSchema = z.enum(["success", "failed"]);
export type CostExportRunStatus = z.infer<typeof CostExportRunStatusSchema>;

export const SelectCostExportSchema = createSelectSchema(
  schema.costExportsTable,
  {
    format: CostExportFormatSchema,
    schedule: CostExportScheduleSchema,
    lastRunStatus: CostExportRunStatusSchema.nullable(),
  },
);

/** API shape: the run lease is internal. */
export const PublicCostExportSchema = SelectCostExportSchema.omit({
  runningUntil: true,
  consecutiveFailures: true,
}).extend({
  blobProviderName: z.string(),
  running: z
    .boolean()
    .describe("Whether a run is queued or in progress right now."),
  nextRetryAt: z
    .date()
    .nullable()
    .describe(
      "When a failing export is next retried; retries back off from 5 minutes to an hour. Null unless the last run failed.",
    ),
});

/** Payload of a queued run (`cost_export_run` task). */
export const CostExportRunTaskPayloadSchema = z.object({
  costExportId: z.uuid(),
  /** The run lease's expiry when claimed; identifies the claim. */
  claimedUntil: z.iso.datetime(),
  /** Rewrite the latest completed period when nothing is due (Run now). */
  rewriteLatest: z.boolean(),
});

const PathPrefixSchema = z
  .string()
  .trim()
  .max(512)
  .transform((value) => value.replace(/^\/+|\/+$/g, ""))
  .describe(
    "Key prefix for the export's files, under the blob provider's own prefix.",
  );

export const CreateCostExportRequestSchema = z.object({
  name: z.string().trim().min(1).max(256),
  blobProviderId: z.uuid(),
  format: CostExportFormatSchema.default("focus_csv"),
  schedule: CostExportScheduleSchema.default("daily"),
  pathPrefix: PathPrefixSchema.default("cost-exports"),
  enabled: z.boolean().default(true),
  startFrom: z.iso
    .datetime()
    .optional()
    .describe(
      "Export usage from this time on, including the past (a backfill). Defaults to now: the first file is the period in progress.",
    ),
});

export const UpdateCostExportRequestSchema = z.object({
  name: z.string().trim().min(1).max(256).optional(),
  blobProviderId: z.uuid().optional(),
  format: CostExportFormatSchema.optional(),
  schedule: CostExportScheduleSchema.optional(),
  pathPrefix: PathPrefixSchema.optional(),
  enabled: z.boolean().optional(),
});

/** What one run wrote. */
export type CostExportRunResult = {
  files: {
    key: string;
    location: string;
    rows: number;
    periodStart: string;
    periodEnd: string;
  }[];
};

export type CostExport = z.infer<typeof SelectCostExportSchema>;
export type PublicCostExport = z.infer<typeof PublicCostExportSchema>;
export type CreateCostExportRequest = z.infer<
  typeof CreateCostExportRequestSchema
>;
export type UpdateCostExportRequest = z.infer<
  typeof UpdateCostExportRequestSchema
>;

/** One hour of one charge of LLM usage, as the cost export reads it. */
export type CostExportUsageRow = {
  hour: string;
  provider: string;
  model: string | null;
  billingMode: string;
  teamId: string | null;
  teamName: string | null;
  agentId: string | null;
  agentName: string | null;
  agentType: string | null;
  appId: string | null;
  appName: string | null;
  connectorId: string | null;
  connectorName: string | null;
  userId: string | null;
  userEmail: string | null;
  /** Numeric aggregates as decimal strings (exact; never floats). */
  requests: string;
  inputTokens: string;
  outputTokens: string;
  cacheReadTokens: string;
  cacheWriteTokens: string;
  cost: string;
};
