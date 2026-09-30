import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { openappaGithubSyncTable } from "@/database/schemas/openappa-github-sync";

const AppaSyncIntervalSchema = z.enum(["15m", "1h", "1d"]);
export type AppaSyncInterval = z.infer<typeof AppaSyncIntervalSchema>;

/** Why a pulled document is held instead of published. */
export const HeldPullReasonSchema = z.enum([
  "drops_batteries",
  "changes_credentials",
]);
export type HeldPullReason = z.infer<typeof HeldPullReasonSchema>;
export const AppaGithubSourceSchema = z
  .object({
    repo: z
      .string()
      .trim()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/,
        "Use owner/repository",
      )
      .max(200),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^\p{Cc}\s~^:?*[\\]+$/u, "Use a branch, tag, or commit")
      .nullable()
      .default(null),
    path: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine(
        (path) =>
          path.endsWith(".toml") &&
          !path.includes("\\") &&
          !/\p{Cc}/u.test(path) &&
          path
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== ".."),
        "Use a repository-relative .toml file path",
      ),
    interval: AppaSyncIntervalSchema,
    githubPatId: z.string().uuid().nullable().default(null),
    githubAppConfigId: z.string().uuid().nullable().default(null),
  })
  .strict()
  .refine(
    (source) => !(source.githubPatId && source.githubAppConfigId),
    "Choose only one GitHub credential",
  );
export type AppaGithubSource = z.infer<typeof AppaGithubSourceSchema>;
export const CreateAppaGithubRepositorySchema = z
  .object({
    owner: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*$/)
      .max(39),
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .max(100),
    githubAppConfigId: z.string().uuid(),
    interval: AppaSyncIntervalSchema,
  })
  .strict();
const AppaGithubSyncSchema = createSelectSchema(openappaGithubSyncTable, {
  interval: z.union([AppaSyncIntervalSchema, z.null()]),
  heldReasons: z.array(HeldPullReasonSchema),
  // Held bytes stay in the database like the accepted ones; the hash identifies the pull.
}).omit({ content: true, heldContent: true });
export const AppaGithubSyncStatusSchema = z.object({
  enabled: z.boolean(),
  source: AppaGithubSyncSchema.nullable(),
  hasPolicy: z.boolean(),
});
/** What accepting a held pull published, and what it changed to publish it. */
export const AcceptedHeldPullSchema = z.object({
  contentHash: z.string(),
  sourceCommit: z.string(),
  reasons: z.array(HeldPullReasonSchema),
  droppedBatteries: z.array(z.string()),
  changedVariables: z.array(z.string()),
  status: AppaGithubSyncStatusSchema,
});
export const AppaGithubSyncActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }).strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
  z
    .object({ action: z.literal("schedule"), interval: AppaSyncIntervalSchema })
    .strict(),
]);
