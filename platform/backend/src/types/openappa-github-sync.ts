import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { openappaGithubSyncTable } from "@/database/schemas/openappa-github-sync";
import { GitProviderSchema } from "./git-host";
import { PolicyTestDirectorySchema } from "./openappa-policy-tests";

const AppaSyncIntervalSchema = z.enum(["15m", "1h", "1d"]);
export type AppaSyncInterval = z.infer<typeof AppaSyncIntervalSchema>;

const AppaGithubRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\s~^:?*[\\]+$/u, "Use a branch, tag, or commit")
  .nullable()
  .default(null);

const AppaPolicyPathSchema = z
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
  );

export const AppaGithubSourceSchema = z
  .object({
    repo: z
      .string()
      .trim()
      .regex(
        /^[a-zA-Z0-9][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9_.-]+)+$/,
        "Use owner/repository, or group/project on GitLab",
      )
      .max(400),
    ref: AppaGithubRefSchema,
    path: AppaPolicyPathSchema,
    interval: AppaSyncIntervalSchema,
    validationDirectory: z
      .union([z.literal(""), PolicyTestDirectorySchema])
      .optional(),
    githubPatId: z.string().uuid().nullable().default(null),
    githubAppConfigId: z.string().uuid().nullable().default(null),
    /** A GitLab access token in place of a GitHub credential. */
    gitlabTokenId: z.string().uuid().nullable().default(null),
  })
  .strict()
  .refine(
    (source) =>
      [
        source.githubPatId,
        source.githubAppConfigId,
        source.gitlabTokenId,
      ].filter(Boolean).length <= 1,
    "Choose only one credential",
  )
  .refine(
    (source) => !!source.gitlabTokenId || source.repo.split("/").length === 2,
    "GitHub repositories are owner/repository",
  );
export type AppaGithubSource = z.infer<typeof AppaGithubSourceSchema>;
export const CreateAppaGithubRepositorySchema = z
  .object({
    /** GitHub account, or GitLab group path ("" for the token owner's namespace). */
    owner: z
      .string()
      .regex(/^([a-zA-Z0-9][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9_.-]+)*)?$/)
      .max(255),
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_.-]+$/)
      .max(100),
    /** Exactly one of a GitHub App or a GitLab token. */
    githubAppConfigId: z.string().uuid().optional(),
    gitlabTokenId: z.string().uuid().optional(),
    interval: AppaSyncIntervalSchema,
    /**
     * Use a repository the admin already has: an unchanged template copy is
     * seeded with the current policy; one holding appa.toml becomes the source.
     */
    existing: z.boolean().optional(),
    /** Where an existing repository keeps its policy; defaults to appa.toml on the default branch. */
    ref: AppaGithubRefSchema.optional(),
    path: AppaPolicyPathSchema.optional(),
    /** Where validations live; defaults to the template's traces/. */
    validationDirectory: PolicyTestDirectorySchema.optional(),
    /** Switch a running sync to this repository; the edit flow sends it. */
    replace: z.boolean().optional(),
  })
  .strict()
  .refine(
    (body) => !body.githubAppConfigId !== !body.gitlabTokenId,
    "Choose a GitHub App or a GitLab token",
  );
const AppaGithubSyncSchema = createSelectSchema(openappaGithubSyncTable, {
  interval: z.union([AppaSyncIntervalSchema, z.null()]),
}).omit({ content: true });
export const AppaGithubSyncStatusSchema = z.object({
  enabled: z.boolean(),
  source: AppaGithubSyncSchema.nullable(),
  hasPolicy: z.boolean(),
  validationDirectory: z.string(),
  /** Web origin of the source's host, e.g. https://github.com, for links. */
  githubWebUrl: z.string(),
  /** Which host the source lives on; links and wording follow it. */
  provider: GitProviderSchema,
});
export const AppaGithubSyncActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync") }).strict(),
  z.object({ action: z.literal("disconnect") }).strict(),
  z
    .object({ action: z.literal("schedule"), interval: AppaSyncIntervalSchema })
    .strict(),
]);
