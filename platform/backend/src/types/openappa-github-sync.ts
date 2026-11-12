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
/**
 * How the policy repository protects its server rules files: the branch
 * ruleset Archestra keeps, which makes the policy check the gate. Null while
 * self-service is off, or without a connected GitHub App source.
 */
/**
 * The GitHub App's grants against what self-service needs, with where to
 * change them: the App's permissions page, and the installation that accepts
 * a change.
 */
export const AppaGithubAppGrantsSchema = z.object({
  /** The App's name on GitHub, and its page there. */
  name: z.string(),
  url: z.string().nullable(),
  settingsUrl: z.string(),
  installationUrl: z.string().nullable(),
  permissions: z.array(
    z.object({
      name: z.enum(["contents", "pull_requests", "checks", "administration"]),
      granted: z.boolean(),
    }),
  ),
});

export const AppaRepositoryProtectionSchema = z
  .object({
    /** The name of the policy check, and of the ruleset that requires it. */
    checkName: z.string(),
    /** The GitHub App's grants against what the feature needs, and where to change them. */
    app: AppaGithubAppGrantsSchema.optional(),
    branchRules: z.object({
      state: z.enum([
        "active",
        "incomplete",
        "missing",
        "needs_permission",
        "unavailable",
        "error",
      ]),
      url: z.string().optional(),
      detail: z.string().optional(),
      /** Bypass entries an administrator added on GitHub; they skip the rules. */
      bypassActors: z.number().int().positive().optional(),
      /** A ruleset requires the check while the GitHub App cannot post it. */
      checkRule: z.enum(["unposted"]).optional(),
    }),
    /**
     * Whether the policy file includes the self-service folder, which is
     * what makes the servers' files apply: `included`, or `pull_open` while
     * the pull request that adds the line waits, or `missing`; `unknown`
     * while the repository cannot be read.
     */
    include: z.object({
      folder: z.string(),
      state: z.enum(["included", "pull_open", "missing", "unknown"]),
      pull: z.object({ number: z.number().int(), url: z.string() }).optional(),
    }),
  })
  .nullable();

export const SelfServiceChoiceSchema = z.enum(["enabled", "disabled"]);
/**
 * Whether each MCP server's editors change its own rules through pull
 * requests, and the folder their files live in. Release 1.4 sets both with
 * environment variables, and Settings shows them read-only; later releases
 * save the switch with the Git sync source.
 */
export const AppaSelfServiceSchema = z.object({
  enabled: z.boolean(),
  /** The folder beside the policy file that holds each server's rules file. */
  directory: z.string(),
  /** The environment variable that sets the switch, with its value. */
  environment: z.object({
    variable: z.string(),
    value: SelfServiceChoiceSchema,
  }),
  /** The environment variable that names the folder, with its value. */
  directoryEnvironment: z.object({ variable: z.string(), value: z.string() }),
});
export const AppaGithubSyncStatusSchema = z.object({
  enabled: z.boolean(),
  source: AppaGithubSyncSchema.nullable(),
  selfService: AppaSelfServiceSchema,
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
  /**
   * Open the pull request that adds the self-service folder's include to the
   * policy file, in the caller's name, when the file lacks it and none waits.
   */
  z.object({ action: z.literal("include_servers") }).strict(),
  /**
   * Bring the repository's protection in line now, as each sync does: the
   * branch ruleset that requires the policy check, once the GitHub App may
   * keep it. Finish setup runs it rather than waiting for the next sync.
   */
  z.object({ action: z.literal("protect") }).strict(),
]);
/** Whether the caller's organization lets server editors change their own rules now. */
export const AppaSelfServiceAvailabilitySchema = z.object({
  enabled: z.boolean(),
});
