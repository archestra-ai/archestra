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

/**
 * The self-service folder: beside the policy file, one rules file per MCP
 * server. Outside `batteries/`, no `.` or `..` segment, no `*`, no slash at
 * either end.
 */
export const SelfServiceDirectorySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^(?!batteries(?:\/|$))[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/,
    "Use a folder beside the policy file, such as mcp or rules/servers",
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
    /**
     * Let each MCP server's editors change its own rules through pull
     * requests: the policy check, and the branch ruleset an administrator
     * imports to require it. GitHub App sources
     * only; ARCHESTRA_OPENAPPA_SELF_SERVICE, while set, wins over it.
     */
    selfService: z.boolean().default(false),
    /** Where each server's rules file lives, beside the policy file. */
    selfServiceDirectory: SelfServiceDirectorySchema.default("mcp"),
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
    /** Let each server's editors change its own rules; GitHub App sources only. */
    selfService: z.boolean().optional(),
    /** Where each server's rules file lives, beside the policy file; mcp unless set. */
    selfServiceDirectory: SelfServiceDirectorySchema.optional(),
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
 * ruleset an administrator imports, which makes the policy check the gate.
 * Null while self-service is off, or without a connected GitHub App source.
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
      name: z.enum(["contents", "pull_requests", "checks"]),
      granted: z.boolean(),
    }),
  ),
});

/**
 * The branch ruleset an administrator imports on the policy repository, as
 * GitHub's "Import a ruleset" takes it: one rule, the policy check required
 * from the GitHub App that posts it.
 */
export const AppaBranchRulesetSchema = z.object({
  name: z.string(),
  target: z.literal("branch"),
  /** As GitHub's export writes them, so the import takes the file as is. */
  source_type: z.literal("Repository").optional(),
  source: z.string().optional(),
  enforcement: z.literal("active"),
  conditions: z.object({
    ref_name: z.object({
      include: z.array(z.string()),
      exclude: z.array(z.string()),
    }),
  }),
  bypass_actors: z.array(z.unknown()),
  rules: z.array(
    z.object({
      type: z.string(),
      parameters: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

/** `fresh=true` reads GitHub now, past the minute the last read is kept. */
export const AppaRepositoryProtectionQuerySchema = z.object({
  fresh: z.enum(["true", "false"]).optional(),
});

export const AppaRepositoryProtectionSchema = z
  .object({
    /** The name of the policy check, and of the ruleset that requires it. */
    checkName: z.string(),
    /** The GitHub App's grants against what the feature needs, and where to change them. */
    app: AppaGithubAppGrantsSchema.optional(),
    /**
     * Whether a rule on the synced branch requires the policy check, as
     * GitHub evaluates the branch. Archestra reads the rules and writes
     * none: `missing` and `incomplete` come with the ruleset to import and
     * the repository's Rulesets page, where an administrator imports it.
     */
    branchRules: z.object({
      state: z.enum([
        "active",
        "incomplete",
        "missing",
        "needs_permission",
        "unavailable",
        "error",
      ]),
      /** The ruleset that requires the check, on its host. */
      url: z.string().optional(),
      detail: z.string().optional(),
      /** A rule requires the check while the GitHub App cannot post it. */
      checkRule: z.enum(["unposted"]).optional(),
      /** The repository's Rulesets page, where a ruleset is imported or edited. */
      settingsUrl: z.string().optional(),
      /** The ruleset to import, while no rule requires the check as it should. */
      ruleset: AppaBranchRulesetSchema.optional(),
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
 * requests, and what decides it.
 */
export const AppaSelfServiceSchema = z.object({
  /** In force: the environment variable while one is set, else the saved setting. */
  enabled: z.boolean(),
  /** The setting saved with the Git sync source. */
  setting: z.boolean(),
  /** The folder beside the policy file that holds each server's rules file. */
  directory: z.string(),
  /** The environment variable that sets it, while one does, with its value. */
  environment: z
    .object({ variable: z.string(), value: SelfServiceChoiceSchema })
    .optional(),
  /**
   * Off, a branch rule that still requires the policy check: Archestra
   * posts the check as skipped until the administrator removes the rule.
   */
  leftoverRule: z
    .object({ checkName: z.string(), url: z.string().nullable() })
    .optional(),
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
  /** Turn self-service on or off; refused while the environment variable sets it. */
  z
    .object({
      action: z.literal("self_service"),
      enabled: z.boolean(),
      /** The self-service folder to use when turning on; the saved one unless set. */
      directory: SelfServiceDirectorySchema.optional(),
    })
    .strict(),
  /**
   * Open the pull request that adds the self-service folder's include to the
   * policy file, in the caller's name, when the file lacks it and none waits.
   */
  z.object({ action: z.literal("include_servers") }).strict(),
]);
/** Whether the caller's organization lets server editors change their own rules now. */
export const AppaSelfServiceAvailabilitySchema = z.object({
  enabled: z.boolean(),
});
