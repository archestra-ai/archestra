import { createHash, randomUUID } from "node:crypto";
import {
  getGithubWebOrigin,
  gitHostFromUrl,
  slugifyMcpServerName,
  TimeInMs,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { userHasPermission } from "@/auth";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config, {
  OPENAPPA_SELF_SERVICE_DIRECTORY_VARIABLE,
  OPENAPPA_SELF_SERVICE_VARIABLE,
} from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import { RuntimeCredentialDefinitionModel } from "@/models";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import MemberModel from "@/models/member";
import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import OpenAppaCredentialBindingModel from "@/models/openappa-credential-binding";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import RoleCompositionModel from "@/models/role-composition";
import {
  catalogToolPrefixes,
  openappaBatteriesService,
} from "@/openappa/batteries";
import {
  addedGrants,
  openappaDeclarations,
  type PolicyResolution,
} from "@/openappa/declarations";
import {
  asRecord,
  includesServerRulesFolder,
  isServerRulesFile,
  isServerRulesFolder,
  repositoryIncludePaths,
  requesterOf,
  serverRulesInclude,
  serverRulesPrefix,
  withIncludeEntry,
  withoutRepositoryIncludes,
} from "@/openappa/policy-text";
import { OPENAPPA_TEMPLATE } from "@/openappa/template.generated";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import {
  githubFetch,
  githubJson,
  githubSetupRead,
  githubSourceFetch,
  githubSyncErrors,
  isEmptyGithubRepository,
  withGithubMessage,
} from "@/services/openappa-github";
import {
  configuredServerRulesFolder,
  githubAppLogin,
  githubAppProfile,
  MissingGithubPermission,
  openappaRepositoryIncludes,
  type RepositorySource,
  repositoryPath,
  resolveOpenAppaGithubAccess,
  resolveOpenAppaGitlabAccess,
} from "@/services/openappa-github-access";
import { openappaGitlab } from "@/services/openappa-gitlab";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import type { AppaGithubSource } from "@/types/openappa-github-sync";
import { mapWithConcurrency } from "@/utils/concurrency";

export async function getAppaGithubSync(organizationId: string) {
  const [row, suite] = await Promise.all([
    OpenAppaGithubSyncModel.find(organizationId),
    OpenAppaPolicyTestsModel.find(organizationId),
  ]);
  const validationDirectory = row?.repo ? (suite?.directory ?? "traces") : "";
  const { webUrl: githubWebUrl, provider } = await sourceWebOrigin({
    organizationId,
    githubAppConfigId: row?.githubAppConfigId ?? null,
    gitlabTokenId: row?.gitlabTokenId ?? null,
  });
  if (!row)
    return {
      enabled: enterpriseTier.isOpenappaActive(),
      source: null,
      selfService: selfServiceState(),
      hasPolicy: false,
      validationDirectory,
      githubWebUrl,
      provider,
    };
  // The accepted bytes never leave the database.
  const { content, ...source } = row;
  return {
    enabled: enterpriseTier.isOpenappaActive(),
    source,
    selfService: selfServiceState(),
    hasPolicy: content !== null,
    validationDirectory,
    githubWebUrl,
    provider,
  };
}

type SyncRow = NonNullable<
  Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>
>;

/**
 * Whether each MCP server's editors change its own rules through pull
 * requests, and the folder their files live in. Release 1.4 reads both from
 * the environment, off by default, and Settings shows them read-only; later
 * releases save the switch with the source.
 */
function selfServiceState() {
  const value = config.openappa.selfService;
  const directory = configuredServerRulesFolder();
  return {
    enabled: value === "enabled",
    directory,
    environment: { variable: OPENAPPA_SELF_SERVICE_VARIABLE, value },
    directoryEnvironment: {
      variable: OPENAPPA_SELF_SERVICE_DIRECTORY_VARIABLE,
      value: directory,
    },
  };
}

/**
 * Whether self-service is in force on a source: on, and a GitHub App
 * source that syncs, since the policy check and the branch ruleset are the
 * App's. A token or a GitLab source never gets them.
 */
export function selfServiceActive(row: SyncRow | null): row is SyncRow & {
  interval: NonNullable<SyncRow["interval"]>;
  repo: string;
  path: string;
  githubAppConfigId: string;
} {
  return (
    !!row?.interval &&
    !!row.repo &&
    !!row.path &&
    !!row.githubAppConfigId &&
    selfServiceState().enabled
  );
}

/** Whether self-service is in force on the organization's saved source. */
export async function selfServiceInForce(organizationId: string) {
  return selfServiceActive(await OpenAppaGithubSyncModel.find(organizationId));
}

/**
 * Whether self-service is set up in full, which is when the registry offers
 * its action and the Keeper's server rules tools work: on by the variable,
 * a GitHub App source that has synced, the servers' folder included by the
 * accepted policy, and the branch ruleset active. Before that, Finish setup
 * on the Git sync card completes it; the ruleset's state is the protection
 * read the card shows, kept for a minute and replaced by each sync.
 */
export async function selfServiceSetupComplete(
  organizationId: string,
): Promise<boolean> {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!selfServiceActive(row) || !row.sourceCommit) return false;
  const policy = await guardrailsPolicyService.get(organizationId);
  if (!includesServerRulesFolder(policy.content, configuredServerRulesFolder()))
    return false;
  const protection = await getRepositoryProtection(organizationId);
  return protection?.branchRules.state === "active";
}

/** What the MCP registry asks: whether its servers' editors may change their rules now. */
export async function getAppaSelfService(organizationId: string) {
  return {
    enabled:
      enterpriseTier.isOpenappaActive() &&
      (await selfServiceSetupComplete(organizationId)),
  };
}
export async function configureAppaGithubSync(params: {
  organizationId: string;
  userId: string;
  source: AppaGithubSource;
}) {
  assertEnabled();
  const current = await OpenAppaGithubSyncModel.find(params.organizationId);
  await saveSource({
    ...params,
    // Editing the same repository keeps waiting on its setup pull request;
    // dropping it would pull the template's policy before the merge.
    source:
      current?.repo === params.source.repo && current.setupPullRequestNumber
        ? {
            ...params.source,
            setupPullRequestNumber: current.setupPullRequestNumber,
          }
        : params.source,
  });
  await OpenAppaGithubSyncModel.enqueue(params.organizationId);
  return getAppaGithubSync(params.organizationId);
}

/**
 * Make an existing repository's policy file the organization's policy source
 * and pull it before answering, so the caller learns at once whether the
 * repository, file and credential work. A first pull that fails leaves the
 * sync stopped and the current policy in force.
 */
export async function connectAppaGithubRepository(params: {
  organizationId: string;
  userId: string;
  source: AppaGithubSource;
  /** Switch a running sync to this repository instead of refusing. */
  replace?: boolean;
}) {
  assertEnabled();
  if (
    !params.replace &&
    (await OpenAppaGithubSyncModel.find(params.organizationId))?.interval
  )
    throw new ApiError(
      409,
      "Stop the current Git sync before connecting another repository",
    );
  await saveSource(params);
  await syncAppaGithubPolicy(params.organizationId);
  const row = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (row?.lastSyncError) {
    await OpenAppaGithubSyncModel.setInterval(params.organizationId, null);
    throw new ApiError(
      400,
      `Could not connect ${params.source.repo}: ${row.lastSyncError} The current policy is unchanged.`,
    );
  }
  return getAppaGithubSync(params.organizationId);
}

/** Seed a private policy repository, falling back to a PR when rules block the commit. */
export async function createAppaGithubRepository(params: {
  organizationId: string;
  userId: string;
  owner: string;
  name: string;
  githubAppConfigId?: string;
  gitlabTokenId?: string;
  interval: AppaGithubSource["interval"];
  existing?: boolean;
  ref?: string | null;
  path?: string;
  validationDirectory?: string;
  replace?: boolean;
}) {
  assertEnabled();
  if (
    !params.replace &&
    (await OpenAppaGithubSyncModel.find(params.organizationId))?.interval
  )
    throw new ApiError(
      409,
      "Stop the current Git sync before creating a repository",
    );
  // Release 1.4: the deployment's variables decide, for every GitHub App source.
  const selfService =
    config.openappa.selfService === "enabled" && !!params.githubAppConfigId;
  const selfServiceDirectory = configuredServerRulesFolder();
  if (selfService) checkSelfServiceDirectory(selfServiceDirectory, params);
  if (
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "credential",
      "read",
    ))
  )
    throw new ApiError(403, "You do not have access to GitHub credentials");
  if (params.gitlabTokenId)
    return createAppaGitlabProject({
      ...params,
      gitlabTokenId: params.gitlabTokenId,
    });
  if (!params.githubAppConfigId)
    throw new ApiError(400, "Choose a GitHub App or a GitLab token");
  const githubAppConfigId = params.githubAppConfigId;
  // The installation-wide token: the repository does not exist yet.
  const { token: appToken, api } = await resolveOpenAppaGithubAccess({
    organizationId: params.organizationId,
    githubPatId: null,
    githubAppConfigId,
  });
  const token = appToken as string;
  const policy = await guardrailsPolicyService.get(params.organizationId);
  // A repository setup starts gets the servers' folder included from the
  // first commit, so no later pull request has to add the line.
  const seed = selfService
    ? await withServerRulesInclude(policy.content, selfServiceDirectory)
    : policy.content;
  if (Buffer.byteLength(seed) > 1024 * 1024)
    throw new ApiError(
      400,
      "The current policy exceeds the 1 MiB Git sync limit",
    );
  // A policy kept elsewhere than appa.toml on the default branch is never a fresh copy.
  const validationDirectory =
    params.validationDirectory ?? VALIDATION_DIRECTORY;
  // Everything the policy reads from its repository is read before anything
  // is written, so a transfer that cannot be complete creates nothing.
  const transfer = await collectSetupTransfer({
    organizationId: params.organizationId,
    policy,
  });

  let created: {
    full_name?: string;
    default_branch?: string;
    private?: boolean;
  };
  const repo = `${params.owner}/${params.name}`;
  let setupPullRequestNumber: number | undefined;
  let seededEmpty = false;
  const custom =
    params.existing &&
    (!!params.ref ||
      (!!params.path && params.path !== "appa.toml") ||
      validationDirectory !== VALIDATION_DIRECTORY);
  if (
    params.existing &&
    !custom &&
    (await isEmptyGithubRepository({ api, repo, token }))
  ) {
    // Where the template is out of reach (GitHub Enterprise Server), the admin
    // creates an empty repository and setup writes the template into it.
    const seeded = await seedEmptyRepository({
      api,
      repo,
      token,
      policy: seed,
      transferred: transferredFiles(transfer, {
        path: "appa.toml",
        validationDirectory,
      }),
    });
    created = { full_name: repo, default_branch: seeded.branch, private: true };
    setupPullRequestNumber = seeded.setupPullRequestNumber;
    seededEmpty = true;
  } else if (params.existing) {
    const notTemplate = new ApiError(400, "Not a template copy");
    try {
      if (custom) throw notTemplate;
      created = await recoverPristineTemplateRepository({
        api,
        repo,
        token,
        error: notTemplate,
      });
    } catch (error) {
      if (error !== notTemplate) throw error;
      // A repository that already holds a policy keeps it until the pull
      // request that carries the current policy and its files is merged.
      return proposeSetupPullRequest({
        organizationId: params.organizationId,
        api,
        repo,
        token,
        ref: params.ref ?? null,
        path: params.path ?? "appa.toml",
        seed,
        transfer,
        policy,
        source: {
          interval: params.interval,
          githubAppConfigId,
          // Kept even before the folder exists: validations run once it does.
          validationDirectory,
        },
      });
    }
  } else {
    try {
      created = await githubJson({
        url: `${api}/repos/${TEMPLATE_REPO}/generate`,
        token,
        method: "POST",
        body: {
          owner: params.owner,
          name: params.name,
          private: true,
          include_all_branches: false,
        },
        errors: withGithubMessage(
          (status) =>
            new ApiError(
              status === 422 ? 409 : 502,
              status === 422
                ? `GitHub rejected ${repo} (HTTP 422). If this is a new repository from an earlier attempt, retry setup after the App can access it. Otherwise choose a different name.`
                : status === 404
                  ? `GitHub could not create a repository under ${params.owner} (HTTP 404). Check that the selected App is installed on that exact account with All repositories access and the required permissions.`
                  : `GitHub returned HTTP ${status} while creating ${repo}. Check the App installation and permissions.`,
            ),
        ),
      });
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 409) throw error;
      created = await recoverPristineTemplateRepository({
        api,
        repo,
        token,
        error,
      });
    }
  }
  if (
    created.full_name?.toLowerCase() !== repo.toLowerCase() ||
    !created.default_branch ||
    !/^[^\p{Cc}\s~^:?*[\\]+$/u.test(created.default_branch)
  )
    throw new ApiError(502, "GitHub returned an unexpected repository");
  if (!seededEmpty)
    try {
      const base = `${api}/repos/${repo}`;
      const branch = created.default_branch;
      // The template's own example is replaced in one commit with the current
      // policy and what it reads beside it; identical bytes need no commit.
      const outcome = await commitSetupFiles({
        base,
        token,
        branch,
        parent: await branchHead({ base, token, branch, setup: true }),
        files: [
          { path: "appa.toml", content: seed },
          ...transferredFiles(transfer, {
            path: "appa.toml",
            validationDirectory,
          }),
        ],
        message: "Seed current OpenAPPA policy",
        pull: {
          title: "Seed current OpenAPPA policy",
          body: setupPullBody(transfer, false),
        },
        direct: true,
      });
      setupPullRequestNumber = outcome.setupPullRequestNumber;
    } catch (error) {
      if (error instanceof ApiError)
        throw new ApiError(
          error.statusCode,
          `Repository ${repo} exists, but its initial policy setup failed: ${error.message}`,
        );
      throw error;
    }
  if (
    (await guardrailsPolicyService.get(params.organizationId)).revision !==
    policy.revision
  )
    throw new ApiError(
      409,
      `The policy changed while creating ${repo}. Review the repository and connect it manually.`,
    );
  const source = {
    repo,
    ref: created.default_branch,
    path: "appa.toml",
    interval: params.interval,
    githubPatId: null,
    githubAppConfigId,
    gitlabTokenId: null,
    // The template ships this folder, so validations work without a setup step.
    validationDirectory,
    setupPullRequestNumber,
  };
  await beforeSourceChange(params.organizationId, source);
  await OpenAppaGithubSyncModel.save(params.organizationId, source);
  await syncAppaGithubPolicy(params.organizationId);
  return getAppaGithubSync(params.organizationId);
}

/**
 * An existing repository that already holds a policy at `path`: the current
 * policy and what it reads beside it go in as a pull request against the
 * branch, so the repository's own policy is replaced only by a merge, and the
 * current one stays in force until then. The merging user combines the two
 * where they want both. A repository whose files already match connects
 * without a pull request.
 */
async function proposeSetupPullRequest(params: {
  organizationId: string;
  api: string;
  repo: string;
  token: string;
  ref: string | null;
  path: string;
  seed: string;
  transfer: SetupTransfer;
  policy: { revision: number };
  source: Pick<
    AppaGithubSource,
    "interval" | "githubAppConfigId" | "validationDirectory"
  >;
}) {
  const { api, repo, token, path } = params;
  const base = `${api}/repos/${repo}`;
  let setupPullRequestNumber: number | undefined;
  try {
    const branch = params.ref ?? (await defaultBranch({ token, base }));
    const outcome = await commitSetupFiles({
      base,
      token,
      branch,
      parent: await branchHead({ base, token, branch }),
      files: [
        { path, content: params.seed },
        ...transferredFiles(params.transfer, {
          path,
          validationDirectory:
            params.source.validationDirectory ?? VALIDATION_DIRECTORY,
        }),
      ],
      message: "Seed current OpenAPPA policy",
      pull: {
        title: "Seed current OpenAPPA policy",
        body: setupPullBody(params.transfer, true),
      },
      direct: false,
    });
    setupPullRequestNumber = outcome.setupPullRequestNumber;
  } catch (error) {
    if (error instanceof ApiError)
      throw new ApiError(
        error.statusCode,
        `Repository ${repo} holds a policy, but the pull request carrying the current one failed: ${error.message}`,
      );
    throw error;
  }
  if (
    (await guardrailsPolicyService.get(params.organizationId)).revision !==
    params.policy.revision
  )
    throw new ApiError(
      409,
      `The policy changed while proposing it to ${repo}. Review the repository and connect it manually.`,
    );
  const source = {
    ...params.source,
    repo,
    ref: params.ref,
    path,
    githubPatId: null,
    gitlabTokenId: null,
    setupPullRequestNumber,
  };
  await beforeSourceChange(params.organizationId, source);
  await OpenAppaGithubSyncModel.save(params.organizationId, source);
  await syncAppaGithubPolicy(params.organizationId);
  const row = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (row?.lastSyncError) {
    await OpenAppaGithubSyncModel.setInterval(params.organizationId, null);
    throw new ApiError(
      400,
      `Could not connect ${repo}: ${row.lastSyncError} The current policy is unchanged.`,
    );
  }
  return getAppaGithubSync(params.organizationId);
}

/**
 * The GitLab side of creating a policy repository: a new private project (or
 * an existing empty one) seeded from the bundled template, or an existing
 * project that already holds a policy, proposed the current one as a merge
 * request.
 */
async function createAppaGitlabProject(params: {
  organizationId: string;
  userId: string;
  owner: string;
  name: string;
  gitlabTokenId: string;
  interval: AppaGithubSource["interval"];
  existing?: boolean;
  ref?: string | null;
  path?: string;
  validationDirectory?: string;
  replace?: boolean;
}) {
  const access = await resolveOpenAppaGitlabAccess({
    organizationId: params.organizationId,
    gitlabTokenId: params.gitlabTokenId,
  });
  const policy = await guardrailsPolicyService.get(params.organizationId);
  if (Buffer.byteLength(policy.content) > 1024 * 1024)
    throw new ApiError(400, "The current policy exceeds the 1 MiB sync limit");
  const validationDirectory =
    params.validationDirectory ?? VALIDATION_DIRECTORY;
  const transfer = await collectSetupTransfer({
    organizationId: params.organizationId,
    policy,
  });
  const repo = params.owner ? `${params.owner}/${params.name}` : params.name;
  let seeded: {
    repo: string;
    branch: string | null;
    path?: string;
    setupPullRequestNumber?: number;
  };
  if (params.existing) {
    const status = await openappaGitlab.repositoryStatus({
      access,
      repo,
      ref: params.ref ?? undefined,
      path: params.path ?? "appa.toml",
      validationDirectory,
    });
    if (status.status !== "empty") {
      // A project that already holds a policy keeps it until the merge
      // request that carries the current policy and its files is merged.
      const path = params.path ?? "appa.toml";
      const proposed = await openappaGitlab.proposeSetup({
        access,
        repo,
        ref: params.ref ?? null,
        files: [
          { path, content: policy.content },
          ...transferredFiles(transfer, { path, validationDirectory }),
        ],
        title: "Seed current OpenAPPA policy",
        summary: setupPullBody(transfer, true),
      });
      seeded = {
        repo,
        branch: params.ref ?? null,
        path,
        setupPullRequestNumber: proposed?.iid,
      };
    } else
      seeded = {
        repo,
        ...(await openappaGitlab.seedExisting({
          access,
          repo,
          policy: policy.content,
          transferred: transferredFiles(transfer, {
            path: "appa.toml",
            validationDirectory,
          }),
        })),
      };
  } else {
    seeded = await openappaGitlab.createProject({
      access,
      namespace: params.owner || null,
      name: params.name,
      policy: policy.content,
      transferred: transferredFiles(transfer, {
        path: "appa.toml",
        validationDirectory,
      }),
    });
  }
  if (
    (await guardrailsPolicyService.get(params.organizationId)).revision !==
    policy.revision
  )
    throw new ApiError(
      409,
      `The policy changed while creating ${seeded.repo}. Review the project and connect it manually.`,
    );
  const source = {
    repo: seeded.repo,
    ref: seeded.branch,
    path: seeded.path ?? "appa.toml",
    interval: params.interval,
    githubPatId: null,
    githubAppConfigId: null,
    gitlabTokenId: params.gitlabTokenId,
    validationDirectory,
    setupPullRequestNumber: seeded.setupPullRequestNumber,
  };
  await beforeSourceChange(params.organizationId, source);
  await OpenAppaGithubSyncModel.save(params.organizationId, source);
  await syncAppaGithubPolicy(params.organizationId);
  const row = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (seeded.setupPullRequestNumber !== undefined && row?.lastSyncError) {
    await OpenAppaGithubSyncModel.setInterval(params.organizationId, null);
    throw new ApiError(
      400,
      `Could not connect ${repo}: ${row.lastSyncError} The current policy is unchanged.`,
    );
  }
  return getAppaGithubSync(params.organizationId);
}

export async function updateAppaGithubSync(params: {
  organizationId: string;
  action: "sync" | "disconnect" | "schedule" | "protect";
  interval?: AppaGithubSource["interval"];
}) {
  assertEnabled();
  const row = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (!row || row.interval === null)
    throw new ApiError(409, "Connect a GitHub source first");
  if (params.action === "sync")
    await syncAppaGithubPolicy(params.organizationId);
  else if (params.action === "protect")
    await maintainRepositoryProtection(params.organizationId);
  else {
    // A stopped sync posts no check, so the ruleset that requires it goes too.
    if (params.action === "disconnect" && selfServiceActive(row))
      await withdrawRepositoryProtection(params.organizationId);
    await OpenAppaGithubSyncModel.setInterval(
      params.organizationId,
      params.action === "disconnect" ? null : (params.interval ?? row.interval),
    );
  }
  return getAppaGithubSync(params.organizationId);
}

/** Refuse a self-service folder the servers' files cannot live in. */
function checkSelfServiceDirectory(
  directory: string,
  source: { validationDirectory?: string | null; path?: string | null },
) {
  if (!isServerRulesFolder(directory))
    throw new ApiError(
      400,
      `${directory} cannot hold the servers' rules files: use a folder beside the policy file, outside batteries/, such as mcp.`,
    );
  const validations = source.validationDirectory || VALIDATION_DIRECTORY;
  if (
    directory === validations ||
    directory.startsWith(`${validations}/`) ||
    validations.startsWith(`${directory}/`)
  )
    throw new ApiError(
      400,
      `${directory} is the validations folder, or inside it; keep the servers' rules files apart from the validations.`,
    );
}

/**
 * The policy with the servers' folder included through `<folder>/*.toml`,
 * or as it is when it includes the folder already.
 */
async function withServerRulesInclude(
  content: string,
  directory: string,
): Promise<string> {
  const entry = serverRulesInclude(directory);
  if (repositoryIncludePaths(content).includes(entry)) return content;
  try {
    return await withIncludeEntry(content, entry);
  } catch (error) {
    throw new ApiError(
      400,
      `The current policy cannot include ${entry}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function syncAppaGithubPolicy(organizationId: string) {
  if (!enterpriseTier.isOpenappaActive()) return;
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row?.interval) return;
  // A row can exist for its declaration flags alone, with no source configured.
  if (!row.repo || !row.path) {
    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: row.revision,
      outcome: { error: "Connect a GitHub repository and file before syncing" },
    });
    return;
  }
  const { repo, path } = row;
  try {
    const read = row.gitlabTokenId
      ? await openappaGitlab.readPolicy({
          access: await resolveOpenAppaGitlabAccess({
            organizationId,
            gitlabTokenId: row.gitlabTokenId,
          }),
          repo,
          ref: row.ref,
          path,
          setupMergeRequest: row.setupPullRequestNumber,
        })
      : await readGithubPolicy({ row, repo, path });
    if (read.pending) {
      await OpenAppaGithubSyncModel.finish({
        organizationId,
        revision: row.revision,
        outcome: {
          error:
            read.pending === "closed"
              ? `The initial policy ${row.gitlabTokenId ? "merge request" : "pull request"} was closed without merging. Reopen and merge it to finish setup, or stop syncing to keep managing the policy locally.`
              : null,
        },
      });
      return;
    }
    const { content } = read;
    const commit = { sha: read.commitSha };
    const { local } = await checkCommitPolicy({
      organizationId,
      source: { ...row, repo },
      commitSha: commit.sha,
      content,
    });
    const contentHash = createHash("sha256").update(content).digest("hex");
    const published = await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: row.revision,
      outcome: { content, contentHash, sourceCommit: commit.sha },
    });
    // A download that raced a source edit or a disconnect published nothing, so
    // the declarations it would have carried upstream are still unpublished.
    if (!published) {
      logger.info(
        { organizationId },
        "OpenAPPA discarded a GitHub pull: the source changed while it downloaded",
      );
      return;
    }
    await openappaBatteriesService.recompileOrganizations([organizationId]);
    if (local.revision === 0 || local.contentHash !== contentHash)
      await queuePolicyValidation(organizationId, contentHash);
  } catch (error) {
    logger.warn({ err: error, organizationId }, "OpenAPPA GitHub sync failed");
    // Never persist raw transport/native diagnostics, which can contain credentials or policy bytes.
    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: row.revision,
      outcome: {
        error:
          error instanceof ApiError
            ? error.message
            : "Could not sync the APPA policy. Check the repository, file, and GitHub credential, then retry.",
      },
    });
  }
  // Every sync also keeps the repository's protection for server rules files
  // in line: the branch ruleset. A failure there shows
  // in the protection status and never fails the pull.
  try {
    await maintainRepositoryProtection(organizationId);
  } catch (error) {
    logger.warn(
      { organizationId, error },
      "OpenAPPA could not bring the policy repository's protection in line",
    );
  }
}
/**
 * Every check a pull makes before it accepts a commit's policy, storing
 * nothing: the repository files folded in at that commit, the credential
 * declarations, the bindings a pull may not hand to new code, and APPA's own
 * validation. Throws an ApiError naming why the commit would be refused.
 */
async function checkCommitPolicy(params: {
  organizationId: string;
  source: RepositorySource;
  commitSha: string;
  content: string;
}): Promise<{
  local: Awaited<ReturnType<typeof guardrailsPolicyService.get>>;
}> {
  const { organizationId, content } = params;
  const local = await guardrailsPolicyService.get(organizationId);
  // The repository files the pulled policy includes are read at the same
  // commit and checked folded in; the policy text is stored as written.
  const pulled = await openappaRepositoryIncludes.foldAt({
    organizationId,
    content,
    files: await openappaRepositoryIncludes.read({
      source: params.source,
      commit: params.commitSha,
      paths: repositoryIncludePaths(content),
    }),
  });
  if (pulled.errors.length > 0)
    throw new ApiError(400, pulled.errors.join("\n"));
  const kept = await openappaRepositoryIncludes.expand({
    organizationId,
    content: local.content,
  });
  const previous =
    kept.errors.length > 0
      ? withoutRepositoryIncludes(local.content)
      : kept.content;
  // Named on its own: the generic refusal below would hide what to change.
  const credentialErrors = await openappaDeclarations.credentialErrors(
    pulled.content,
  );
  if (credentialErrors.length > 0)
    throw new ApiError(400, credentialErrors.join("\n"));
  const resolved = await resolvePair({
    organizationId,
    local: previous,
    pulled: pulled.content,
  });
  const validation = await guardrailsPolicyService
    .validate(pulled.content, {
      organizationId,
      previous,
      resolved: { submitted: resolved.pulled, previous: resolved.local },
    })
    .catch((error) => {
      logger.warn(
        { organizationId, error },
        "OpenAPPA could not check a pulled policy",
      );
      // An outage, not a verdict on the policy: the caller tries again.
      throw new ApiError(
        503,
        "APPA could not check this policy right now. Git sync tries again at its next check.",
      );
    });
  if (!validation.valid)
    throw new ApiError(
      400,
      "APPA rejected this policy. Use a valid, self-contained TOML policy whose battery includes this deployment can answer.",
    );
  const granted = uploadedGrants(resolved);
  if (granted.length > 0)
    throw new ApiError(
      400,
      `The repository's policy would hand ${granted
        .map(
          (grant) =>
            `${grant.variable} to the uploaded ${grant.battery} battery`,
        )
        .join(
          ", and ",
        )}. A pull cannot give a credential to new code; remove the include, or unbind the variable.`,
    );
  return { local };
}

async function queuePolicyValidation(
  organizationId: string,
  policyHash: string,
) {
  try {
    await OpenAppaPolicyTestsModel.enqueuePolicyValidation(
      organizationId,
      policyHash,
    );
  } catch (error) {
    logger.warn(
      { err: error, organizationId },
      "OpenAPPA could not queue informational validation after a policy change",
    );
  }
}
export async function checkDueAppaGithubSyncs() {
  if (!enterpriseTier.isOpenappaActive()) return;
  for (const row of await OpenAppaGithubSyncModel.findDue())
    await OpenAppaGithubSyncModel.enqueue(row.organizationId);
  // Open pull requests get a pull's checks every minute, before they merge,
  // on the repositories whose servers' editors change their own rules.
  await mapWithConcurrency(
    (await OpenAppaGithubSyncModel.findConnected()).filter(selfServiceActive),
    4,
    async (row) => {
      try {
        await checkAppaGithubPullRequests(row.organizationId);
      } catch (error) {
        logger.warn(
          { organizationId: row.organizationId, error },
          "OpenAPPA could not check the policy repository's pull requests",
        );
      }
    },
  );
}

// =============================================================================
// Pull request checks: a pull's own checks on what a pull request would merge
// =============================================================================

/**
 * The check every policy pull request carries, and the name of the branch
 * ruleset that requires it: ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME. A renamed
 * deployment moves the ruleset and its required check over at the next sync.
 */
export const POLICY_CHECK_NAME = config.openappa.policyCheckName;

/** The most open pull requests checked in one repository each minute. */
const MAX_CHECKED_PULLS = 50;

/** How long a check stands for one pull request result and deployment. */
const CHECKED_TTL = TimeInMs.Day;

/**
 * How often a refused result is checked again while nothing it is keyed by
 * moves: a refusal can rest on state outside that key, such as a credential's
 * value, and a later repair should not wait for a new commit.
 */
const RECHECK_REFUSED = 15 * TimeInMs.Minute;

/**
 * How long a repository that refused a check is left alone: a credential
 * without the permission is not asked again every minute.
 */
const REFUSED_TTL = 10 * TimeInMs.Minute;

/**
 * How often who asked for a pull request, and whether they still may, is
 * read again while its head stands: an edit grant taken away, or a GitHub
 * account connected, shows within this long.
 */
const RECHECK_AUTHORSHIP = 15 * TimeInMs.Minute;

/** How long a pull request that changes no policy file is left alone, per head. */
const UNRELATED_TTL = TimeInMs.Day;

/** The most changed files and commits one pull request may hold to be checked. */
const MAX_PULL_FILES = 1000;
const MAX_PULL_COMMITS = 250;

/** The host refused the credential: it may not list pull requests or post the check. */
class CheckRefused extends ApiError {
  constructor(status: number) {
    super(403, `The policy check was refused (HTTP ${status})`);
  }
}

/** The outcome posted for one pull request result, and the two checks behind it. */
type CheckedResult = {
  accepted: boolean;
  reason: string | null;
  /**
   * The policy's own check, the deployment it was checked against, and when;
   * absent while the pull request changes nothing Git sync reads.
   */
  policy: (Verdict & { deployment: string }) | null;
  /** What the pull request changes that Git sync reads, and whether it may. */
  judged: Verdict & { governed: string[] };
};

/** One check's outcome as stored. */
type Verdict = {
  accepted: boolean;
  title: string | null;
  reason: string | null;
  checkedAt: number;
};

/**
 * Check every open pull request (merge request on GitLab) into the synced
 * branch as a pull would check its result, and post the outcome on its head
 * commit as the policy check (ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME). A branch rule that
 * requires the check stops a merge Git sync would refuse; without one, the
 * reviewers still see it.
 *
 * What was checked is kept in the shared cache, so another replica's pass
 * neither checks a result again nor posts it twice. A result is checked again
 * when a commit moves on either side, or when the deployment it was checked
 * against changes (`deploymentState`), and a refusal every fifteen minutes
 * besides. Only a changed outcome is posted.
 */
async function checkAppaGithubPullRequests(organizationId: string) {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row?.repo || !row.path || !row.interval || !row.sourceCommit) return;
  const source = { ...row, repo: row.repo, path: row.path };
  const refused = refusedChecksKey(organizationId, source.repo);
  if (await cacheManager.get(refused)) return;
  const checkName = POLICY_CHECK_NAME;
  let pulls: CheckedPull[];
  try {
    pulls = await githubPullRequests(source);
  } catch (error) {
    // A credential the host refuses is not asked again every minute.
    if (
      !(error instanceof MissingGithubPermission) &&
      !(error instanceof CheckRefused)
    )
      throw error;
    await refuseChecks({ key: refused, organizationId, reason: error.message });
    return;
  }
  const deployment = await deploymentState(organizationId, row.sourceCommit);
  const checking = pulls.slice(0, MAX_CHECKED_PULLS);
  // What the source reads decides which files a pull request governs, so a
  // policy file or servers' folder moved makes every stored result stale,
  // the unrelated ones included.
  const keys = checking.map((pull) =>
    checkKey(
      "checked",
      "v3",
      organizationId,
      source.repo,
      source.ref ?? "",
      source.path,
      configuredServerRulesFolder(),
      String(source.githubAppConfigId ?? ""),
      checkName,
      pull.head,
      pull.result,
    ),
  );
  const checked = await cacheManager.getMany<CheckedResult>(keys);
  for (const [index, pull] of checking.entries()) {
    const key = keys[index] as AllowedCacheKey;
    const stored = checked.get(key);
    // A result stored in an earlier shape is checked again whole.
    const previous = stored?.judged ? stored : undefined;
    const now = Date.now();
    // What the pull request changes, and who asked, stand for a while; the
    // policy's check while the deployment it was checked against does, a
    // refusal for a while.
    const judgedStands =
      previous !== undefined &&
      now - previous.judged.checkedAt <
        (previous.judged.governed.length === 0
          ? UNRELATED_TTL
          : RECHECK_AUTHORSHIP);
    const policyStands =
      previous !== undefined &&
      (previous.policy === null ||
        (previous.policy.deployment === deployment &&
          (previous.policy.accepted ||
            now - previous.policy.checkedAt < RECHECK_REFUSED)));
    if (judgedStands && policyStands) continue;
    const judged = judgedStands
      ? previous.judged
      : await (async () => {
          const read = pull.judge
            ? await pull.judge()
            : // A host that cannot tell: check the policy for every request.
              { governed: ["*"], outcome: { accepted: true } as PullOutcome };
          const made = verdict(read?.outcome ?? null, { checkedAt: now });
          return made && read ? { ...made, governed: read.governed } : null;
        })();
    // A read or a check that failed for now is checked again next minute.
    if (!judged) continue;
    // Nothing Git sync reads changed: nothing to check, and the check says so
    // rather than hold the pull request.
    const unrelated = judged.governed.length === 0 && judged.accepted;
    const policy = unrelated
      ? null
      : policyStands && previous?.policy
        ? previous.policy
        : verdict(await outcomeAt({ source, commitSha: pull.result }), {
            deployment,
            checkedAt: now,
          });
    if (!unrelated && !policy) continue;
    // The policy's own fault first: it is the one a reviewer fixes in the diff.
    const failed = [policy, judged].find((check) => check && !check.accepted);
    const outcome: PullOutcome = failed
      ? {
          accepted: false,
          title: failed.title ?? undefined,
          reason: failed.reason ?? "",
        }
      : unrelated
        ? { accepted: true, skipped: true }
        : { accepted: true };
    const result: CheckedResult = {
      accepted: outcome.accepted,
      reason: outcome.accepted ? null : outcome.reason,
      policy,
      judged,
    };
    // A changed deployment that leaves the outcome as posted posts nothing.
    if (
      previous?.accepted !== result.accepted ||
      previous.reason !== result.reason
    )
      try {
        await pull.post(outcome);
      } catch (error) {
        if (error instanceof CheckRefused) {
          await refuseChecks({
            key: refused,
            organizationId,
            reason:
              "a GitHub App needs the Checks permission (read and write), and a GitLab token the api scope",
          });
          return;
        }
        logger.warn(
          { organizationId, err: error },
          "OpenAPPA could not post the policy check on a pull request; it tries again next minute",
        );
        continue;
      }
    await cacheManager
      .set(key, result, CHECKED_TTL)
      .catch((err) =>
        logger.warn(
          { organizationId, err },
          "OpenAPPA could not record a posted policy check; the next pass checks it again",
        ),
      );
  }
}

/** The key under which a refused round of checks waits ten minutes. */
function refusedChecksKey(organizationId: string, repo: string) {
  return checkKey("refused", organizationId, repo);
}

/**
 * Forget a refusal: the App was just granted what it lacked, so the next
 * minute's round posts the checks instead of waiting out the ten minutes.
 */
async function forgetRefusedChecks(organizationId: string, repo: string) {
  await cacheManager
    .delete(refusedChecksKey(organizationId, repo))
    .catch((err) =>
      logger.warn(
        { organizationId, err },
        "OpenAPPA could not forget a refused policy check",
      ),
    );
}

/** A shared cache key for the policy check, from its parts. */
function checkKey(
  kind: "checked" | "refused" | "protection",
  ...parts: string[]
) {
  return `${CacheKey.OpenAppaPolicyCheck}-${kind}-${createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")}` as const;
}

async function refuseChecks(params: {
  key: AllowedCacheKey;
  organizationId: string;
  reason: string;
}) {
  logger.warn(
    { organizationId: params.organizationId, reason: params.reason },
    "OpenAPPA cannot check the policy repository's pull requests; it asks again in ten minutes",
  );
  await cacheManager
    .set(params.key, true, REFUSED_TTL)
    .catch((err) =>
      logger.warn(
        { organizationId: params.organizationId, err },
        "OpenAPPA could not record a refused policy check",
      ),
    );
}

/**
 * What a pull's checks depend on besides the commit checked: the accepted
 * commit, whose files the current policy folds in; the composition the
 * organization serves; and the battery packages and credential bindings it
 * holds, which a pull request can use before the served policy does, such as
 * a package uploaded after the pull request first named it.
 */
async function deploymentState(
  organizationId: string,
  sourceCommit: string,
): Promise<string> {
  const [served, packages, bindings] = await Promise.all([
    OpenAppaEffectivePolicyModel.findState(organizationId),
    OpenAppaBatteryPackageModel.list(organizationId),
    OpenAppaCredentialBindingModel.list(organizationId),
  ]);
  return createHash("sha256")
    .update(
      JSON.stringify([
        sourceCommit,
        served?.rootRevision ?? null,
        served?.contentHash ?? null,
        served?.installFingerprint ?? null,
        packages.map((stored) => stored.contentHash).sort(),
        bindings.map((binding) => [binding.variable, binding.credentialKey]),
      ]),
    )
    .digest("hex");
}

type PullOutcome =
  /** Passed; `skipped` when the pull request changes nothing Git sync reads. */
  | { accepted: true; skipped?: true }
  | { accepted: false; title?: string; reason: string };

type CheckedPull = {
  head: string;
  /** The commit checked: GitHub's merge result when it has one, else the head. */
  result: string;
  post: (outcome: PullOutcome) => Promise<void>;
  /**
   * The files Git sync reads that the pull request changes, and, for one
   * Archestra opened, whether the person who asked may change them; null for
   * a read that failed for now. Absent where the host cannot tell, in which
   * case the policy is checked for every pull request.
   */
  judge?: () => Promise<Judged | null>;
};

/** What a pull request changes that Git sync reads, and whether it may. */
type Judged = { governed: string[]; outcome: PullOutcome };

type PolicySource = RepositorySource & {
  path: string;
  ref: string | null;
  validationDirectory?: string | null;
};

/** An outcome as stored, or null for one that is not in yet. */
function verdict<Extra extends object>(
  outcome: PullOutcome | null,
  extra: Extra & { checkedAt: number },
): (Verdict & Extra) | null {
  if (!outcome) return null;
  return {
    accepted: outcome.accepted,
    title: outcome.accepted ? null : (outcome.title ?? null),
    reason: outcome.accepted ? null : outcome.reason,
    ...extra,
  };
}

/** Whether a pull would accept the policy at `commitSha`; null for a passing failure. */
async function outcomeAt(params: {
  source: PolicySource;
  commitSha: string;
}): Promise<PullOutcome | null> {
  const { source } = params;
  // The policy file is read like an include entry beside it.
  const name = source.path.slice(source.path.lastIndexOf("/") + 1);
  try {
    const content = (
      await openappaRepositoryIncludes.read({
        source,
        commit: params.commitSha,
        paths: [name],
      })
    ).get(name);
    if (content === undefined)
      return {
        accepted: false,
        reason: `${source.path} is not in this pull request's result`,
      };
    await checkCommitPolicy({
      organizationId: source.organizationId,
      source,
      commitSha: params.commitSha,
      content,
    });
    return { accepted: true };
  } catch (error) {
    if (error instanceof ApiError && error.statusCode < 500)
      return { accepted: false, reason: error.message };
    logger.warn(
      { organizationId: source.organizationId, error },
      "OpenAPPA could not check a policy pull request",
    );
    return null;
  }
}

function checkSummary(outcome: PullOutcome) {
  if (outcome.accepted && outcome.skipped)
    return {
      title: "No policy files changed",
      summary: `This pull request changes nothing Git sync reads: not the policy file, no file it includes, no MCP server rules file and no validation. ${archestraMcpBranding.appName} checked nothing.`,
    };
  return outcome.accepted
    ? {
        title: "Git sync would accept this policy",
        summary: `${archestraMcpBranding.appName} checked the policy this pull request would merge, with every file it includes, as Git sync checks a commit before applying it.`,
      }
    : {
        title: outcome.title ?? "Git sync would refuse this policy",
        summary: outcome.reason,
      };
}

async function githubPullRequests(
  source: PolicySource,
): Promise<CheckedPull[]> {
  const { token, api } = await resolveOpenAppaGithubAccess(source, {
    pull_requests: "read",
    checks: "write",
  });
  if (!token) return [];
  const base = `${api}/repos/${source.repo}`;
  const checkName = POLICY_CHECK_NAME;
  const appId = await checkIntegrationId(source);
  const branch =
    source.ref ??
    (
      await githubJson<{ default_branch: string }>({
        url: base,
        token,
        errors: githubSyncErrors,
      })
    ).default_branch;
  const pulls = await githubJson<
    Array<{
      number?: number;
      head?: { sha?: string };
      merge_commit_sha?: string | null;
      user?: { id?: number; login?: string; type?: string } | null;
    }>
  >({
    url: `${base}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=${MAX_CHECKED_PULLS}`,
    token,
    errors: async ({ status }) =>
      status === 401 || status === 403
        ? new CheckRefused(status)
        : new ApiError(502, `GitHub returned HTTP ${status}`),
  });
  return pulls.flatMap((pull) => {
    const head = pull.head?.sha;
    if (!head || !/^[a-f0-9]{40}$/.test(head)) return [];
    const merged = pull.merge_commit_sha;
    const number = pull.number;
    return [
      {
        head,
        result: merged && /^[a-f0-9]{40}$/.test(merged) ? merged : head,
        post: (outcome) =>
          postGithubCheck({ base, token, head, appId, outcome, checkName }),
        ...(number
          ? {
              judge: () =>
                judgeGithubPull({
                  source,
                  token,
                  api,
                  base,
                  number,
                  user: pull.user ?? null,
                }),
            }
          : {}),
      },
    ];
  });
}

// --- Authorship: who asked for a pull request, and whether they may ---

type GithubPullUser = { id?: number; login?: string; type?: string };

/**
 * Whether the person behind a pull request may change what it changes: each
 * server rules file takes edit access to that server in the MCP registry,
 * and the policy file, any other `.toml` beside it and the validations take
 * the guardrailsPolicy:update permission. Files Git sync never reads are
 * nobody's concern here.
 *
 * Who asked is read from what GitHub vouches for. A pull request Archestra
 * opened, from the APPA Keeper or Settings, is made of commits GitHub signed
 * for Archestra's credential, whose author is the person who asked; any other
 * commit on it means someone else pushed, and the pull request is refused.
 * A pull request a person opened is theirs, found by the GitHub account they
 * connected in Archestra. Null for a read that failed for now.
 */
/**
 * What a pull request changes that Git sync reads, and whether the person who
 * asked may change it. Who asked is judged for a pull request Archestra
 * opened, from the APPA Keeper or Settings: its commits are signed by GitHub
 * for Archestra's App, and their author is the requester, who must still
 * hold edit access to each MCP server whose file it changes (the policy file
 * and the rest take guardrailsPolicy:update); a commit someone else pushed
 * onto that branch refuses it. A pull request a person opened on GitHub is
 * the repository's own business: who may open and merge one is decided by
 * GitHub's permissions and reviews, and this check reads its policy alone.
 * Null for a read that failed for now.
 */
async function judgeGithubPull(params: {
  source: PolicySource;
  token: string;
  api: string;
  base: string;
  number: number;
  user: GithubPullUser | null;
}): Promise<{ outcome: PullOutcome; governed: string[] } | null> {
  const { source, token, base, number } = params;
  const appName = archestraMcpBranding.appName;
  const changed = await pagedGithub<{
    filename?: string;
    previous_filename?: string;
  }>({
    token,
    url: `${base}/pulls/${number}/files`,
    max: MAX_PULL_FILES,
  });
  if (changed === null) return null;
  if (changed === "over")
    return {
      governed: [],
      outcome: {
        accepted: false,
        title: "This pull request changes too many files to check",
        reason: `${appName} checks who may change each file in a pull request of up to ${MAX_PULL_FILES} files. Split this one.`,
      },
    };
  const governed = governedFiles(
    source,
    changed.flatMap((file) =>
      [file.filename, file.previous_filename].filter(
        (path): path is string => typeof path === "string",
      ),
    ),
  );
  const paths = governed.map((file) => file.path);
  if (governed.length === 0)
    return { governed: paths, outcome: { accepted: true } };
  const own = await ownIdentity({ source });
  if (own === null) return null;
  const byArchestra =
    own !== undefined &&
    own.login.toLowerCase() === params.user?.login?.toLowerCase();
  if (!byArchestra) return { governed: paths, outcome: { accepted: true } };
  const requester = await archestraPullRequester({
    ...params,
    own,
    governed,
  });
  if (requester === null) return null;
  if ("refused" in requester)
    return { governed: paths, outcome: requester.refused };
  const { userId, email } = requester;
  const prefixes = governed.some((file) => file.prefix !== null)
    ? await catalogToolPrefixes(source.organizationId)
    : null;
  let needsPolicyPermission = false;
  for (const file of governed) {
    const catalogIds = file.prefix ? prefixes?.byPrefix.get(file.prefix) : null;
    if (!catalogIds || catalogIds.size !== 1) {
      // No server of that name, or more than one: the policy's own matter.
      needsPolicyPermission = true;
      continue;
    }
    const [catalogId] = [...catalogIds] as [string];
    const allowed = await ResourcePermissions.allows({
      organizationId: source.organizationId,
      userId,
      resource: "mcpRegistry",
      scope: catalogId,
      action: "update",
    });
    if (!allowed) {
      const catalog = await InternalMcpCatalogModel.findById(catalogId);
      return {
        governed: paths,
        outcome: {
          accepted: false,
          title: "The requester may not change these rules",
          reason: `${email} may not change ${file.path}: that takes edit access to the MCP server ${catalog?.name ?? file.prefix} in the MCP registry.`,
        },
      };
    }
  }
  if (needsPolicyPermission) {
    const permissions = await RoleCompositionModel.getUserPermissions({
      userId,
      organizationId: source.organizationId,
    });
    if (!permissions.guardrailsPolicy?.includes("update")) {
      const first = governed.find(
        (file) =>
          !file.prefix ||
          (prefixes?.byPrefix.get(file.prefix)?.size ?? 0) !== 1,
      );
      return {
        governed: paths,
        outcome: {
          accepted: false,
          title: "The requester may not change the policy",
          reason: `${email} may not change ${first?.path ?? source.path}: that takes the guardrailsPolicy:update permission.`,
        },
      };
    }
  }
  return { governed: paths, outcome: { accepted: true } };
}

/**
 * The changed files Git sync reads, with the tool prefix of each server
 * rules file: the policy file and any `.toml` beside or below it, and the
 * validations folder.
 */
function governedFiles(
  source: PolicySource,
  paths: string[],
): Array<{ path: string; prefix: string | null }> {
  const folder = repositoryPath(source, "");
  const validations = repositoryPath(
    source,
    source.validationDirectory || "traces",
  );
  const within = (path: string, parent: string) =>
    parent === "" || path === parent || path.startsWith(`${parent}/`);
  const servers = configuredServerRulesFolder();
  const seen = new Set<string>();
  return paths.flatMap((path) => {
    if (seen.has(path)) return [];
    seen.add(path);
    const relative = folder === "" ? path : path.slice(folder.length + 1);
    if (within(path, folder) && isServerRulesFile(servers, relative))
      return [{ path, prefix: serverRulesPrefix(servers, relative) }];
    if (
      path === source.path ||
      (within(path, folder) && path.endsWith(".toml")) ||
      within(path, validations)
    )
      return [{ path, prefix: null }];
    return [];
  });
}

/**
 * The member who asked for a pull request Archestra's App opened, read from
 * its commits: every one must be signed by GitHub for the App, which signs a
 * commit the App makes through its API as its author (the committer is the
 * App, or GitHub's own web-flow on the Contents API), and the trailer
 * Archestra wrote into each message names the member. Otherwise why that
 * cannot be told; null for a read that failed for now.
 */
async function archestraPullRequester(params: {
  source: PolicySource;
  token: string;
  base: string;
  number: number;
  own: { login: string };
  governed: Array<{ path: string }>;
}): Promise<
  { userId: string; email: string } | { refused: PullOutcome } | null
> {
  const { source, token, base, number, own } = params;
  const appName = archestraMcpBranding.appName;
  const commits = await pagedGithub<{
    sha?: string;
    commit?: {
      message?: string;
      verification?: { verified?: boolean };
    };
    author?: { login?: string } | null;
    committer?: { login?: string } | null;
  }>({ token, url: `${base}/pulls/${number}/commits`, max: MAX_PULL_COMMITS });
  if (commits === null) return null;
  const ours = (login: string | undefined) =>
    login?.toLowerCase() === own.login.toLowerCase();
  const foreign =
    commits === "over" ||
    commits.some(
      (entry) =>
        entry.commit?.verification?.verified !== true ||
        !(ours(entry.author?.login) || ours(entry.committer?.login)),
    );
  if (foreign)
    return {
      refused: {
        accepted: false,
        title: "Could not tell who asked for this change",
        reason: `This pull request has commits ${appName} did not make, so ${appName} cannot tell who asked for them. Propose the change again from the APPA Keeper or Settings → Guardrails, or open a pull request as yourself.`,
      },
    };
  const emails = new Set(
    commits.map((entry) => requesterOf(entry.commit?.message)),
  );
  const [email] = [...emails];
  const member =
    emails.size === 1 && email
      ? await MemberModel.findByIdOrEmail(email, source.organizationId)
      : null;
  if (member) return { userId: member.id, email: member.email };
  return {
    refused: {
      accepted: false,
      title: "Could not tell who asked for this change",
      reason: `${appName} opened this pull request for someone who is no longer a member. Propose the change again from the APPA Keeper or Settings → Guardrails.`,
    },
  };
}

/**
 * The GitHub account Archestra's App acts as, `<slug>[bot]`. Undefined
 * without an App, null for a read that failed for now.
 */
async function ownIdentity(params: {
  source: PolicySource;
}): Promise<{ login: string } | null | undefined> {
  const { source } = params;
  if (!source.githubAppConfigId) return undefined;
  try {
    const login = await githubAppLogin(source);
    return login ? { login } : undefined;
  } catch (error) {
    logger.warn(
      { organizationId: source.organizationId, error },
      "OpenAPPA could not read the GitHub App's own login",
    );
    return null;
  }
}

/**
 * Every page of a GitHub list, up to `max` entries: "over" past that, null
 * when a page could not be read.
 */
async function pagedGithub<T>(params: {
  token: string;
  url: string;
  max: number;
}): Promise<T[] | "over" | null> {
  const all: T[] = [];
  for (let page = 1; all.length <= params.max; page++) {
    const read = await githubCall<T[]>({
      token: params.token,
      url: `${params.url}${params.url.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    });
    if (!read.ok || !Array.isArray(read.body)) return null;
    all.push(...read.body);
    if (read.body.length < 100) return all.length > params.max ? "over" : all;
  }
  return "over";
}

/**
 * The check run on a pull request's head, posted as the App. A run this App
 * already has on the head is updated in place, name included: GitHub never
 * removes a completed run, so a renamed check (ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME)
 * would otherwise leave its old self beside the new one on every open pull
 * request.
 */
async function postGithubCheck(params: {
  base: string;
  token: string;
  head: string;
  appId: number | undefined;
  outcome: PullOutcome;
  checkName: string;
}) {
  const { base, token, head, outcome } = params;
  const { title, summary } = checkSummary(outcome);
  const refused = async ({ status }: { status: number }) =>
    status === 403 || status === 404
      ? new CheckRefused(status)
      : new ApiError(502, `GitHub returned HTTP ${status}`);
  // Best effort: a listing that fails for now means a new run, which GitHub
  // shows in place of the earlier one of the same name.
  const existing = params.appId
    ? await githubCall<{ check_runs?: Array<{ id?: number }> }>({
        token,
        url: `${base}/commits/${head}/check-runs?app_id=${params.appId}&per_page=100`,
      }).catch(() => null)
    : null;
  const runs = (existing?.ok ? (existing.body.check_runs ?? []) : []).flatMap(
    (run) => (typeof run.id === "number" ? [run.id] : []),
  );
  const body = {
    name: params.checkName,
    status: "completed",
    conclusion: !outcome.accepted
      ? "failure"
      : outcome.skipped
        ? "skipped"
        : "success",
    output: { title, summary: summary.slice(0, 60_000) },
  };
  // Every run of this App on the head takes the name and the outcome, so a
  // run under an earlier name shows no stale verdict; GitHub shows the latest.
  if (runs.length > 0)
    for (const run of runs)
      await githubJson({
        url: `${base}/check-runs/${run}`,
        token,
        method: "PATCH",
        body,
        errors: refused,
      });
  else
    await githubJson({
      url: `${base}/check-runs`,
      token,
      method: "POST",
      body: { ...body, head_sha: head },
      errors: refused,
    });
}

/**
 * The stored bindings a pull would newly hand to an uploaded battery. The
 * pulled text names no credential (`credentialErrors` refuses it), so every
 * grant is a binding reaching an included battery. A bundled battery is code
 * this deployment ships and the binding was set for it; an uploaded package
 * reading a bound variable is code the repository chose, so the pull is
 * refused rather than left for someone to approve.
 */
function uploadedGrants(params: {
  local: PolicyResolution;
  pulled: PolicyResolution;
}): Array<{ battery: string; variable: string; key: string }> {
  const { local, pulled } = params;
  const uploaded = new Set(
    pulled.entries
      .filter((entry) => entry.source !== "bundled")
      .map((entry) => entry.name),
  );
  return addedGrants(
    openappaDeclarations.grants(local),
    openappaDeclarations.grants(pulled),
  ).filter((grant) => uploaded.has(grant.battery));
}

/**
 * The local text and the pulled one, resolved together with the stored
 * credential bindings applied: neither answers for the other.
 */
async function resolvePair(params: {
  organizationId: string;
  local: string;
  pulled: string;
}): Promise<{ local: PolicyResolution; pulled: PolicyResolution }> {
  const { organizationId } = params;
  const [local, pulled] = await Promise.all([
    openappaDeclarations.resolveWithBindings({
      organizationId,
      content: params.local,
    }),
    openappaDeclarations.resolveWithBindings({
      organizationId,
      content: params.pulled,
    }),
  ]);
  return { local: local.resolution, pulled: pulled.resolution };
}

async function saveSource(params: {
  organizationId: string;
  userId: string;
  source: AppaGithubSource & { setupPullRequestNumber?: number };
}) {
  if (
    (params.source.githubPatId ||
      params.source.githubAppConfigId ||
      params.source.gitlabTokenId) &&
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "credential",
      "read",
    ))
  ) {
    throw new ApiError(403, "You do not have access to GitHub credentials");
  }
  // Release 1.4: the servers' folder is the deployment's, so a GitHub App
  // source keeps its validations apart from it, as a created repository
  // must. An omitted folder keeps the saved one, as the save does.
  if (
    config.openappa.selfService === "enabled" &&
    params.source.githubAppConfigId
  )
    checkSelfServiceDirectory(configuredServerRulesFolder(), {
      path: params.source.path,
      validationDirectory:
        params.source.validationDirectory ??
        (await OpenAppaPolicyTestsModel.find(params.organizationId))?.directory,
    });
  if (params.source.gitlabTokenId) {
    // Resolve now to reject a missing, foreign or non-GitLab credential.
    const access = await resolveOpenAppaGitlabAccess({
      organizationId: params.organizationId,
      gitlabTokenId: params.source.gitlabTokenId,
    });
    if (params.source.validationDirectory) {
      const ref =
        params.source.ref ??
        (await openappaGitlab.defaultBranch({
          access,
          repo: params.source.repo,
        }));
      await openappaGitlab.loadPolicyTests({
        access,
        repo: params.source.repo,
        commitSha: await openappaGitlab.branchCommit({
          access,
          repo: params.source.repo,
          branch: ref,
        }),
        directory: params.source.validationDirectory,
        allowEmpty: true,
      });
    }
    await beforeSourceChange(params.organizationId, params.source);
    await OpenAppaGithubSyncModel.save(params.organizationId, params.source);
    return;
  }
  // Resolve now to reject a missing or cross-organization credential, or an
  // App that cannot read the repository, before saving it.
  const { token, api } = await resolveOpenAppaGithubAccess(
    { ...params.source, organizationId: params.organizationId },
    { contents: "read" },
  );
  if (params.source.validationDirectory) {
    const response = await githubSourceFetch({
      url: `${api}/repos/${params.source.repo}/commits/${encodeURIComponent(params.source.ref ?? "HEAD")}`,
      token: token || undefined,
    });
    const bytes = await readResponseBodyWithLimit(response, 2 * 1024 * 1024);
    if (!bytes) throw new ApiError(400, "GitHub commit response is too large");
    const commit = JSON.parse(bytes.toString()) as { sha?: string };
    if (!commit.sha || !/^[a-f0-9]{40}$/.test(commit.sha))
      throw new ApiError(400, "GitHub returned an invalid commit");
    await loadAppaGithubPolicyTests({
      source: {
        ...params.source,
        organizationId: params.organizationId,
        sourceCommit: commit.sha,
      },
      directory: params.source.validationDirectory,
      allowEmpty: true,
    });
  }
  // Only now, with the new source checked: a save that fails leaves the
  // branch it would have left protected.
  await beforeSourceChange(params.organizationId, params.source);
  await OpenAppaGithubSyncModel.save(params.organizationId, params.source);
}

/** The policy at a GitHub source's ref, or the setup pull request's state while it is open. */
async function readGithubPolicy(params: {
  row: NonNullable<Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>>;
  repo: string;
  path: string;
}): Promise<
  | { pending: "open" | "closed" }
  | { pending: null; commitSha: string; content: string }
> {
  const { row, repo, path } = params;
  const { token, api } = await resolveOpenAppaGithubAccess(
    { ...row, repo },
    { contents: "read", pull_requests: "read" },
  );
  const base = `${api}/repos/${repo}`;
  if (row.setupPullRequestNumber) {
    const pull = await githubJson<{ merged?: boolean; state?: string }>({
      url: `${base}/pulls/${row.setupPullRequestNumber}`,
      token: token ?? "",
      errors: githubSyncErrors,
    });
    if (pull.merged !== true) {
      if (pull.state !== "open" && pull.state !== "closed")
        throw new ApiError(
          502,
          "GitHub returned an invalid setup pull request",
        );
      return { pending: pull.state };
    }
  }
  const commitResponse = await githubSourceFetch(
    {
      url: `${base}/commits/${encodeURIComponent(row.ref ?? "HEAD")}`,
      token: token || undefined,
    },
    row.ref
      ? `Repository not found: ${repo}, or its ${row.ref} branch. It may have been deleted or renamed, or the App lost access. Pick another with Edit source.`
      : `Repository not found: ${repo}. It may have been deleted or renamed, or the App lost access. Pick another with Edit source.`,
  );
  const commitBytes = await readResponseBodyWithLimit(
    commitResponse,
    2 * 1024 * 1024,
  );
  if (!commitBytes)
    throw new ApiError(400, "GitHub commit response is too large");
  const commit = JSON.parse(commitBytes.toString()) as { sha?: unknown };
  if (typeof commit.sha !== "string" || !/^[a-f0-9]{40}$/.test(commit.sha))
    throw new ApiError(400, "GitHub returned an invalid commit");
  const response = await githubSourceFetch(
    {
      url: `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit.sha}`,
      token: token || undefined,
      accept: "application/vnd.github.raw+json",
    },
    `Policy file not found: ${path} in ${repo}. Check the policy file with Edit source.`,
  );
  const bytes = await readResponseBodyWithLimit(response, 1024 * 1024);
  if (!bytes) throw new ApiError(400, "APPA policy exceeds the 1 MiB limit");
  const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return { pending: null, commitSha: commit.sha, content };
}

/** Read from the credential's definition alone, so status reads never touch its secret. */
async function sourceWebOrigin(params: {
  organizationId: string;
  githubAppConfigId: string | null;
  gitlabTokenId: string | null;
}): Promise<{ webUrl: string; provider: "github" | "gitlab" }> {
  const id = params.gitlabTokenId ?? params.githubAppConfigId;
  const definition = id
    ? await RuntimeCredentialDefinitionModel.findById({
        id,
        organizationId: params.organizationId,
      })
    : null;
  if (params.gitlabTokenId)
    return {
      webUrl: gitHostFromUrl({
        provider: "gitlab",
        url: definition?.gitlabUrl,
      }).webUrl,
      provider: "gitlab",
    };
  return {
    webUrl: getGithubWebOrigin(definition?.githubUrl ?? undefined),
    provider: "github",
  };
}

function assertEnabled() {
  if (!enterpriseTier.isOpenappaActive())
    throw new ApiError(
      409,
      "Enable OpenAPPA on the server before configuring Git sync",
    );
}
async function recoverPristineTemplateRepository(params: {
  api: string;
  repo: string;
  token: string;
  error: ApiError;
}) {
  try {
    const repository = await githubJson<{
      full_name?: string;
      default_branch?: string;
      private?: boolean;
      template_repository?: { full_name?: string };
    }>({
      url: `${params.api}/repos/${params.repo}`,
      token: params.token,
      errors: githubSyncErrors,
    });
    if (
      !repository.private ||
      repository.full_name?.toLowerCase() !== params.repo.toLowerCase() ||
      repository.template_repository?.full_name?.toLowerCase() !==
        TEMPLATE_REPO.toLowerCase()
    )
      throw params.error;
    const [existing, template] = await Promise.all([
      githubJson<{ sha?: string }>({
        url: `${params.api}/repos/${params.repo}/contents/appa.toml`,
        token: params.token,
        errors: githubSyncErrors,
      }),
      githubJson<{ sha?: string }>({
        url: `${params.api}/repos/${TEMPLATE_REPO}/contents/appa.toml`,
        token: params.token,
        errors: githubSyncErrors,
      }),
    ]);
    if (!existing.sha || existing.sha !== template.sha) throw params.error;
    return repository;
  } catch {
    throw params.error;
  }
}

const TEMPLATE_REPO = OPENAPPA_TEMPLATE.repo;
const REPOSITORY_RULES =
  /repository rule violations|protected branch update failed|changes must be made through a pull request|required (?:status check|workflow)/i;

/**
 * Writes the bundled template, with the current policy as appa.toml, into an
 * empty repository. Only a contents write can start an empty repository, so
 * the first file goes in alone and the rest follow in one commit, through a
 * pull request when rules protect the branch. An App without the Workflows
 * permission gets everything but the validation workflow.
 */
async function seedEmptyRepository(params: {
  api: string;
  repo: string;
  token: string;
  policy: string;
  transferred: SetupFile[];
}): Promise<{ branch: string; setupPullRequestNumber?: number }> {
  const { token } = params;
  const base = `${params.api}/repos/${params.repo}`;
  const files = OPENAPPA_TEMPLATE.files.map((file) =>
    file.path === "appa.toml" ? { ...file, content: params.policy } : file,
  );
  const [first, ...rest] = files;
  const initial = await githubJson<{ commit?: { sha?: string } }>({
    url: `${base}/contents/${first.path.split("/").map(encodeURIComponent).join("/")}`,
    token,
    method: "PUT",
    body: {
      message: "Start the OpenAPPA policy repository",
      content: Buffer.from(first.content).toString("base64"),
    },
    errors: githubSyncErrors,
  });
  const repository = await githubSetupRead<{ default_branch?: string }>({
    url: base,
    token,
  });
  const branch = repository.default_branch;
  const parent = initial.commit?.sha;
  if (!branch || !parent || !/^[a-f0-9]{40}$/.test(parent))
    throw new ApiError(502, "GitHub returned an unexpected repository");
  const message = "Add the OpenAPPA template and current policy";
  const { setupPullRequestNumber } = await commitSetupFiles({
    base,
    token,
    branch,
    parent,
    files: [...rest, ...params.transferred],
    message,
    pull: { title: message, body: setupPullBody(params.transferred, false) },
    direct: true,
  });
  return { branch, setupPullRequestNumber };
}

/** A file setup writes into the policy repository, by its path there. */
type SetupFile = { path: string; content: string };

/**
 * What the current policy reads beside itself in its repository, read at the
 * commit Git sync accepted so a new repository composes the same policy:
 * every file its `include` list names (a glob's matches with it), and the
 * validations in the validation folder. Without a connected repository the
 * validations are the ones kept locally.
 */
type SetupTransfer = {
  /** By include entry, as the policy names it. */
  includes: Map<string, string>;
  /** By file name, each placed in the validation folder. */
  validations: SetupFile[];
};

async function collectSetupTransfer(params: {
  organizationId: string;
  policy: { content: string };
}): Promise<SetupTransfer> {
  const { organizationId } = params;
  const entries = repositoryIncludePaths(params.policy.content);
  const [current, suite] = await Promise.all([
    OpenAppaGithubSyncModel.find(organizationId),
    OpenAppaPolicyTestsModel.find(organizationId),
  ]);
  // The commit the files are read at, as a composition reads them: kept
  // after a disconnect, until another source replaces it.
  const accepted =
    current?.repo && current.sourceCommit
      ? { ...current, repo: current.repo, sourceCommit: current.sourceCommit }
      : null;
  const includes = new Map<string, string>();
  if (entries.length > 0) {
    if (!accepted)
      throw new ApiError(
        409,
        `The current policy includes ${entries[0]} from its repository, and Git sync has accepted no commit to copy it from. Connect the repository that holds it, or remove the include, before setting up another repository.`,
      );
    for (const [path, text] of await openappaRepositoryIncludes.read({
      source: accepted,
      commit: accepted.sourceCommit,
      paths: entries,
    }))
      includes.set(path, text);
  }
  const validations: SetupFile[] = [];
  if (accepted?.interval) {
    const directory = suite?.directory ?? VALIDATION_DIRECTORY;
    for (const file of await loadAppaGithubPolicyTests({
      source: accepted,
      directory,
      allowEmpty: true,
    }))
      validations.push({
        path: file.path.slice(directory.length + 1),
        content: file.content,
      });
  } else {
    for (const file of suite?.files ?? []) {
      const name = file.path.slice(file.path.lastIndexOf("/") + 1);
      if (validations.some((kept) => kept.path === name))
        throw new ApiError(
          400,
          `Two validations are both named ${name}. Rename one before setting up the repository.`,
        );
      validations.push({ path: name, content: file.content });
    }
  }
  return { includes, validations };
}

/** The transfer's files at their paths beside the policy file at `path`. */
function transferredFiles(
  transfer: SetupTransfer,
  target: { path: string; validationDirectory: string },
): SetupFile[] {
  return [
    ...[...transfer.includes].map(([entry, content]) => ({
      path: repositoryPath({ path: target.path }, entry),
      content,
    })),
    ...transfer.validations.map((file) => ({
      path: `${target.validationDirectory}/${file.path}`,
      content: file.content,
    })),
  ];
}

/** What the setup pull request tells its reviewer. */
function setupPullBody(
  transfer: SetupTransfer | SetupFile[],
  existing: boolean,
): string {
  const carried = Array.isArray(transfer)
    ? transfer.length
    : transfer.includes.size + transfer.validations.length;
  const files =
    carried === 0
      ? ""
      : ` It also carries ${carried === 1 ? "the file" : `the ${carried} files`} the policy reads beside itself.`;
  return existing
    ? `This pull request puts your current OpenAPPA policy in place of the one in this repository.${files} Merge it as it is, or change this branch first to combine the two. Your current policy stays active until this pull request is merged.`
    : `Review and merge this pull request to finish GitHub policy sync setup.${files} Your current policy stays active until this pull request is merged.`;
}

/** The commit a branch points at; `setup` waits for a repository GitHub is still creating. */
async function branchHead(params: {
  base: string;
  token: string;
  branch: string;
  setup?: boolean;
}): Promise<string> {
  const request = {
    url: `${params.base}/git/ref/heads/${params.branch.split("/").map(encodeURIComponent).join("/")}`,
    token: params.token,
  };
  const ref = params.setup
    ? await githubSetupRead<{ object?: { sha?: string } }>(request)
    : await githubJson<{ object?: { sha?: string } }>({
        ...request,
        errors: githubSyncErrors,
      });
  const sha = ref.object?.sha;
  if (!sha || !/^[a-f0-9]{40}$/.test(sha))
    throw new ApiError(502, "GitHub returned an invalid branch");
  return sha;
}

/**
 * One commit on top of `parent` that writes `files`, advanced onto `branch`
 * when `direct`, else proposed as a pull request against it; rules that
 * protect the branch turn a direct write into the pull request too. An App
 * without the Workflows permission gets everything but the validation
 * workflow. Files that leave the tree as it is make no commit at all.
 */
async function commitSetupFiles(params: {
  base: string;
  token: string;
  branch: string;
  parent: string;
  files: SetupFile[];
  message: string;
  pull: { title: string; body: string };
  direct: boolean;
}): Promise<{ setupPullRequestNumber?: number }> {
  const { base, token, branch, parent } = params;
  // The first file at a path wins: the policy comes first.
  const files = [
    ...new Map(params.files.map((file) => [file.path, file])).values(),
  ];
  const parentCommit = await githubJson<{ tree?: { sha?: string } }>({
    url: `${base}/git/commits/${parent}`,
    token,
    errors: githubSyncErrors,
  });
  const commitFiles = async (entries: SetupFile[]) => {
    const tree = await githubJson<{ sha: string }>({
      url: `${base}/git/trees`,
      token,
      method: "POST",
      body: {
        base_tree: parentCommit.tree?.sha,
        tree: entries.map((file) => ({
          path: file.path,
          mode: "100644",
          type: "blob",
          content: file.content,
        })),
      },
      errors: githubSyncErrors,
    });
    // Identical bytes make the same tree: nothing to commit, and GitHub
    // cannot open a pull request with an empty diff.
    if (tree.sha === parentCommit.tree?.sha) return null;
    return githubJson<{ sha: string }>({
      url: `${base}/git/commits`,
      token,
      method: "POST",
      body: { message: params.message, tree: tree.sha, parents: [parent] },
      errors: githubSyncErrors,
    });
  };
  const propose = async (sha: string) => {
    const head = `archestra/openappa-setup-${randomUUID()}`;
    await githubJson({
      url: `${base}/git/refs`,
      token,
      method: "POST",
      body: { ref: `refs/heads/${head}`, sha },
      errors: githubSyncErrors,
    });
    const pull = await githubJson<{ number?: number }>({
      url: `${base}/pulls`,
      token,
      method: "POST",
      errors: githubSyncErrors,
      body: { ...params.pull, head, base: branch },
    });
    if (!Number.isSafeInteger(pull.number) || (pull.number ?? 0) <= 0)
      throw new ApiError(502, "GitHub returned an invalid pull request");
    return { setupPullRequestNumber: pull.number };
  };
  let commit = await commitFiles(files);
  if (!commit) return {};
  if (!params.direct) return propose(commit.sha);
  let outcome: "rules" | "workflow" | null = null;
  const advance = (sha: string) =>
    githubJson({
      url: `${base}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`,
      token,
      method: "PATCH",
      body: { sha },
      errors: withGithubMessage((status, message) => {
        if (
          /workflow/i.test(message ?? "") &&
          !REPOSITORY_RULES.test(message ?? "")
        )
          outcome = "workflow";
        else if (
          [403, 409, 422].includes(status) &&
          REPOSITORY_RULES.test(message ?? "")
        )
          outcome = "rules";
        return new ApiError(
          502,
          `GitHub returned HTTP ${status} while committing the initial policy. Check repository access and App permissions.`,
        );
      }),
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    outcome = null;
    try {
      await advance(commit.sha);
      return {};
    } catch (error) {
      if (outcome === "workflow" && attempt === 0) {
        commit = await commitFiles(
          files.filter((file) => !file.path.startsWith(".github/")),
        );
        if (!commit) return {};
        continue;
      }
      if (outcome !== "rules") throw error;
      return propose(commit.sha);
    }
  }
  throw new ApiError(502, "GitHub didn't accept the initial policy");
}
/** Where the template keeps policy validations; also the default elsewhere. */
const VALIDATION_DIRECTORY = "traces";

/** Read direct .appa files at the supplied pinned commit; no ref drift or writeback. */
export async function loadAppaGithubPolicyTests(params: {
  source: Pick<
    NonNullable<Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>>,
    | "interval"
    | "repo"
    | "sourceCommit"
    | "organizationId"
    | "githubPatId"
    | "githubAppConfigId"
    | "gitlabTokenId"
  >;
  directory: string;
  allowEmpty?: boolean;
}): Promise<{ path: string; content: string }[]> {
  const { source, directory } = params;
  if (!source.interval || !source.repo)
    throw new ApiError(
      409,
      "Connect a GitHub policy repository before loading tests",
    );
  if (!source.sourceCommit || !/^[a-f0-9]{40}$/.test(source.sourceCommit))
    throw new ApiError(409, "GitHub policy sync has no accepted commit yet");
  if (source.gitlabTokenId)
    return openappaGitlab.loadPolicyTests({
      access: await resolveOpenAppaGitlabAccess({
        organizationId: source.organizationId,
        gitlabTokenId: source.gitlabTokenId,
      }),
      repo: source.repo,
      commitSha: source.sourceCommit,
      directory,
      allowEmpty: params.allowEmpty,
    });
  const { token, api } = await resolveOpenAppaGithubAccess(
    { ...source, organizationId: source.organizationId },
    { contents: "read" },
  ).catch((err) => {
    if (err instanceof MissingGithubPermission) throw err;
    logger.warn({ err }, "OpenAPPA could not resolve the GitHub credential");
    throw new ApiError(400, "The configured GitHub credential is unavailable");
  });
  const signal = AbortSignal.timeout(20000);
  const base = `${api}/repos/${source.repo}/contents/`;
  const read = async (path: string, raw: boolean, limit: number) => {
    const response = await githubFetch({
      url: `${base}${path.split("/").map(encodeURIComponent).join("/")}?ref=${source.sourceCommit}`,
      token: token || undefined,
      accept: raw ? "application/vnd.github.raw+json" : undefined,
      signal,
    });
    if (response.status === 401 || response.status === 403)
      throw new ApiError(
        400,
        "GitHub denied access to the policy tests; check the configured credential",
      );
    if (response.status === 404)
      throw new ApiError(
        404,
        "Policy test directory or file was not found at the accepted commit; check repository access and path",
      );
    if (!response.ok)
      throw new ApiError(
        400,
        `GitHub could not load policy tests (HTTP ${response.status})`,
      );
    const bytes = await readResponseBodyWithLimit(response, limit);
    if (!bytes)
      throw new ApiError(
        400,
        "GitHub policy test response exceeds the size limit",
      );
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  let listing: string;
  try {
    listing = await read(directory, false, 262144);
  } catch (error) {
    // A folder not created yet holds no validations; they run once it exists.
    if (
      params.allowEmpty &&
      error instanceof ApiError &&
      error.statusCode === 404
    )
      return [];
    throw error;
  }
  const entries: unknown = JSON.parse(listing);
  if (!Array.isArray(entries))
    throw new ApiError(400, "Select a directory containing .appa files");
  if (entries.length >= 1000)
    throw new ApiError(
      400,
      "GitHub directory listing may be truncated; choose a smaller test directory",
    );
  const paths = entries
    .flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const file = entry as { type?: unknown; path?: unknown; size?: unknown };
      if (
        file.type !== "file" ||
        typeof file.path !== "string" ||
        !file.path.endsWith(".appa")
      )
        return [];
      if (
        !file.path.startsWith(`${directory}/`) ||
        file.path.slice(directory.length + 1).includes("/")
      )
        throw new ApiError(400, "GitHub returned an unexpected test path");
      if (typeof file.size !== "number" || file.size > 65536)
        throw new ApiError(400, "A policy test exceeds the 64 KiB file limit");
      return [file.path];
    })
    .sort();
  if (paths.length > 32)
    throw new ApiError(
      400,
      "Choose a test directory with at most 32 .appa files",
    );
  if (paths.length === 0 && !params.allowEmpty)
    throw new ApiError(
      404,
      "No .appa test files exist directly inside this directory at the accepted commit",
    );
  const files: { path: string; content: string }[] = [];
  let bytes = 0;
  for (const path of paths) {
    const content = await read(path, true, 65536);
    bytes += Buffer.byteLength(content);
    if (bytes > 524288)
      throw new ApiError(
        400,
        "Policy test collection exceeds the 512 KiB limit",
      );
    files.push({ path, content });
  }
  return files;
}

/** A tool prefix that is also a safe file name. */
const SAFE_PREFIX = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;

/** Which servers carry which tool prefixes, as `catalogToolPrefixes` reads them. */
type ToolPrefixes = Awaited<ReturnType<typeof catalogToolPrefixes>>;

/**
 * Whether a server has a rules file of its own: named by its own slug, and
 * only when every one of its tools carries that prefix and no other server's
 * tool does, so no server reaches another's file through its name.
 */
export function hasOwnFile(
  catalog: { id: string; name: string },
  prefixes: ToolPrefixes,
): boolean {
  const prefix = slugifyMcpServerName(catalog.name);
  const carried = prefixes.byCatalog.get(catalog.id);
  return (
    SAFE_PREFIX.test(prefix) &&
    !prefix.includes("__") &&
    !prefixes.conflicting.has(catalog.id) &&
    carried?.size === 1 &&
    carried.has(prefix) &&
    ![...(prefixes.byPrefix.get(prefix) ?? [])].some((id) => id !== catalog.id)
  );
}

// =============================================================================
// Repository protection: who reviews each server's file, and the branch rules
// =============================================================================

/** The permissions the GitHub App needs, each tried as its own job token. */
const GITHUB_APP_PERMISSIONS = [
  "contents",
  "pull_requests",
  "checks",
  "administration",
] as const;

type RepositoryProtection = {
  /** The name of the policy check, and of the ruleset that requires it. */
  checkName: string;
  /**
   * The GitHub App's grants against what this feature needs, with where to
   * change them: an App created before a part existed is upgraded there.
   * Absent for GitLab.
   */
  app?: {
    /** The App's name on GitHub, and its page there. */
    name: string;
    url: string | null;
    settingsUrl: string;
    installationUrl: string | null;
    permissions: Array<{
      name: (typeof GITHUB_APP_PERMISSIONS)[number];
      granted: boolean;
    }>;
  };
  /** The ruleset on the synced branch. */
  branchRules: {
    state:
      | "active"
      | "incomplete"
      | "missing"
      | "needs_permission"
      | "unavailable"
      | "error";
    url?: string;
    detail?: string;
    /** Bypass entries an administrator added on GitHub: they skip these rules. */
    bypassActors?: number;
    /**
     * A ruleset requires the check while the App cannot post it, so pull
     * requests wait on it. Absent while the check is posted.
     */
    checkRule?: "unposted";
  };
};

/**
 * The policy repository's protection while self-service is on, and with
 * `apply` the changes that bring it in line: the branch ruleset that requires
 * the policy check, which is where who may change each file is decided. Null
 * while self-service is off, or without a connected GitHub App source.
 *
 * The ruleset is written with a token limited to the policy repository and
 * Administration. A permission the App was not granted is reported, not
 * raised.
 */
async function repositoryProtection(params: {
  organizationId: string;
  apply: boolean;
}): Promise<RepositoryProtection | null> {
  const row = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (!row?.sourceCommit || !selfServiceActive(row)) return null;
  const source = {
    ...row,
    repo: row.repo,
    path: row.path,
    sourceCommit: row.sourceCommit,
  };
  const checkName = POLICY_CHECK_NAME;
  const [branchRules, app] = await Promise.all([
    githubBranchRules(source, params.apply, checkName).catch((error) => ({
      state: "error" as const,
      detail: protectionError(error),
    })),
    githubAppReadiness(source).catch((error) => {
      logger.warn(
        { organizationId: params.organizationId, error },
        "OpenAPPA could not read the GitHub App's permissions",
      );
      return undefined;
    }),
  ]);
  return { checkName, ...(app ? { app } : {}), branchRules };
}

/**
 * The GitHub App's grants against what self-service needs, read whether or
 * not self-service is on: the switch's dialog asks before turning it on.
 * Null without a GitHub App source.
 */
export async function getAppaGithubAppGrants(
  organizationId: string,
): Promise<RepositoryProtection["app"] | null> {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row?.repo || !row.path || !row.githubAppConfigId) return null;
  // Asked by the switch's dialog and its check-again: what GitHub grants
  // now, not what a token minted earlier still carries.
  const grants = await githubAppReadiness(
    {
      ...row,
      repo: row.repo,
      path: row.path,
      sourceCommit: row.sourceCommit ?? "",
    },
    { fresh: true },
  );
  // Read when the switch's dialog checks again: a grant that just arrived
  // should not wait out a refused round of checks.
  if (grants?.permissions.every((permission) => permission.granted))
    await forgetRefusedChecks(organizationId, row.repo);
  return grants ?? null;
}

/** How long the last protection read or applied stands, by organization. */
const PROTECTION_TTL = TimeInMs.Minute;

/**
 * The last protection read or applied, by organization, in the shared cache:
 * what one replica applies on protect or a sync, every replica shows, and
 * the setup-complete gate reads the same state everywhere. Null is a value
 * (no protection to show); undefined is a miss.
 */
async function cachedProtection(
  organizationId: string,
): Promise<RepositoryProtection | null | undefined> {
  const hit = await cacheManager.get<{
    protection: RepositoryProtection | null;
  }>(checkKey("protection", organizationId));
  return hit ? hit.protection : undefined;
}

/**
 * Best effort, as the in-memory cache it replaces was: a write the cache
 * refuses leaves the next read to go to the repository, and never fails
 * the read, the protect action or the sync that applied the protection.
 */
async function rememberProtection(
  organizationId: string,
  protection: RepositoryProtection | null,
) {
  try {
    await cacheManager.set(
      checkKey("protection", organizationId),
      { protection },
      PROTECTION_TTL,
    );
  } catch (error) {
    logger.warn(
      { organizationId, error },
      "OpenAPPA could not cache the policy repository's protection",
    );
  }
}

/**
 * The repository's protection as the Git sync settings show it: read at most
 * once a minute, and replaced by what each sync applies.
 */
export async function getRepositoryProtection(
  organizationId: string,
): Promise<RepositoryProtection | null> {
  const cached = await cachedProtection(organizationId);
  if (cached !== undefined) return cached;
  const read = await repositoryProtection({ organizationId, apply: false });
  await rememberProtection(organizationId, read);
  return read;
}

/**
 * Bring the repository's protection in line, as each sync does. Off, that
 * means no ruleset of Archestra's left on the repository: one left from when
 * self-service was on, by a setting or by the environment variable, would
 * hold every pull request on a check nobody posts any more.
 */
async function maintainRepositoryProtection(
  organizationId: string,
): Promise<RepositoryProtection | null> {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (
    row?.interval &&
    row.repo &&
    row.githubAppConfigId &&
    !selfServiceActive(row)
  ) {
    await withdrawRepositoryProtection(organizationId);
    return null;
  }
  const applied = await repositoryProtection({ organizationId, apply: true });
  await rememberProtection(organizationId, applied);
  return applied;
}

/**
 * Take the ruleset off the repository: turning self-service off, stopping
 * the sync, or moving it to another repository leaves no rule behind that
 * requires a check nobody posts any more. Best effort: a repository the App
 * can no longer reach is logged, and the setting changes all the same.
 */
async function withdrawRepositoryProtection(organizationId: string) {
  await rememberProtection(organizationId, null);
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row?.repo || !row.githubAppConfigId) return;
  try {
    await removeGithubBranchRules({ ...row, repo: row.repo });
  } catch (error) {
    logger.warn(
      { organizationId, repo: row.repo, error },
      "OpenAPPA could not take its ruleset off the policy repository",
    );
  }
}

/**
 * Before a source is saved: a repository or branch the sync leaves, or a
 * source without a GitHub App, which posts no check, gives its ruleset back
 * first.
 */
async function beforeSourceChange(
  organizationId: string,
  next: { repo: string; ref?: string | null; githubAppConfigId: string | null },
) {
  const current = await OpenAppaGithubSyncModel.find(organizationId);
  if (!selfServiceActive(current)) return;
  // Another repository, or another branch of the same one: the ruleset on
  // the branch the sync leaves would require a check nobody posts there.
  if (
    current?.repo !== next.repo ||
    (current.ref ?? null) !== (next.ref ?? null) ||
    !next.githubAppConfigId
  )
    await withdrawRepositoryProtection(organizationId);
}

type ConnectedSource = NonNullable<
  Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>
> & { repo: string; path: string; sourceCommit: string };

/**
 * Each permission this feature needs, tried as its own job token: GitHub
 * refuses a token for a permission the installation was not granted, so the
 * refusals are the list of what to add on the App and accept on the
 * installation. Undefined without an App.
 */
async function githubAppReadiness(
  source: ConnectedSource,
  options?: { fresh?: boolean },
): Promise<RepositoryProtection["app"]> {
  if (!source.githubAppConfigId) return undefined;
  const profile = await githubAppProfile(source);
  if (!profile) return undefined;
  const permissions = await Promise.all(
    GITHUB_APP_PERMISSIONS.map(async (name) => {
      try {
        await resolveOpenAppaGithubAccess(source, { [name]: "write" }, options);
        return { name, granted: true };
      } catch (error) {
        if (error instanceof MissingGithubPermission)
          return { name, granted: false };
        throw error;
      }
    }),
  );
  return {
    name: profile.name,
    url: profile.htmlUrl,
    settingsUrl: profile.settingsUrl,
    installationUrl: profile.installationUrl,
    permissions,
  };
}

function protectionError(error: unknown): string {
  return error instanceof ApiError
    ? error.message
    : "Could not reach the policy repository";
}

// === Branch rules ===

type Rule = { type: string; parameters?: Record<string, unknown> };

type Ruleset = {
  name: string;
  target: string;
  enforcement: string;
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } };
  bypass_actors?: unknown[];
  rules?: Rule[];
};

async function githubBranchRules(
  source: ConnectedSource,
  apply: boolean,
  /** The check's name for this App, and the ruleset's. */
  checkName: string,
): Promise<RepositoryProtection["branchRules"]> {
  let access: Awaited<ReturnType<typeof resolveOpenAppaGithubAccess>>;
  try {
    access = await resolveOpenAppaGithubAccess(source, {
      administration: "write",
    });
  } catch (error) {
    if (error instanceof MissingGithubPermission)
      return { state: "needs_permission", detail: error.message };
    throw error;
  }
  const { token, api, web } = access;
  if (!token)
    return {
      state: "needs_permission",
      detail:
        "The policy repository is read without a credential. Connect a GitHub App with the Administration permission.",
    };
  const base = `${api}/repos/${source.repo}`;
  const branch = source.ref ?? (await defaultBranch({ token, base }));
  const rulesets = await githubCall<
    Array<{ id: number; name: string; source_type?: string }>
  >({ token, url: `${base}/rulesets?includes_parents=false&per_page=100` });
  if (!rulesets.ok) return unavailable(rulesets);
  const repositoryRulesets = rulesets.body.filter(
    (ruleset) => (ruleset.source_type ?? "Repository") === "Repository",
  );
  const integrationId = await checkIntegrationId(source);
  // Ours by name, or by its shape: a deployment renamed since
  // (ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME) finds its ruleset again and
  // renames it, instead of leaving one that holds every pull request.
  let ours = repositoryRulesets.find((ruleset) => ruleset.name === checkName);
  let existing: Awaited<ReturnType<typeof githubCall<Ruleset>>> | null = null;
  if (!ours && integrationId) {
    for (const candidate of repositoryRulesets.slice(0, 25)) {
      const read = await githubCall<Ruleset>({
        token,
        url: `${base}/rulesets/${candidate.id}`,
      });
      if (read.ok && isOurRulesetShape(read.body.rules, integrationId)) {
        ours = candidate;
        existing = read;
        break;
      }
    }
  }
  const page = (id: number) => `${web}/${source.repo}/rules/${id}`;
  // The check is required only while this App may post it: a required check
  // nobody posts holds every pull request for good.
  const check = await policyCheckAccess(source, checkName);
  if (!check.postable) {
    if (!ours) return { state: "needs_permission", detail: check.detail };
    existing ??= await githubCall<Ruleset>({
      token,
      url: `${base}/rulesets/${ours.id}`,
    });
    return {
      state: "active",
      url: page(ours.id),
      ...(existing.ok && requiresPolicyCheck(existing.body.rules, checkName)
        ? { checkRule: "unposted" as const, detail: check.detail }
        : { detail: check.detail }),
    };
  }
  const desired = desiredRuleset({ branch, integrationId, checkName });
  if (!ours) {
    if (!apply) return { state: "missing" };
    const created = await githubCall<{ id: number }>({
      token,
      url: `${base}/rulesets`,
      method: "POST",
      body: desired,
    });
    if (!created.ok) return unavailable(created);
    return { state: "active", url: page(created.body.id) };
  }
  existing ??= await githubCall<Ruleset>({
    token,
    url: `${base}/rulesets/${ours.id}`,
  });
  if (!existing.ok) return unavailable(existing);
  const { include = [], exclude = [] } =
    existing.body.conditions?.ref_name ?? {};
  // Whether `~DEFAULT_BRANCH` names the synced branch, read only when used.
  const isDefault =
    source.ref === null ||
    ([...include, ...exclude].includes("~DEFAULT_BRANCH") &&
      (await defaultBranch({ token, base })) === branch);
  const strengthened = strengthenedRuleset(existing.body, desired, {
    ref: `refs/heads/${branch}`,
    isDefault,
  });
  // Kept as an administrator added them, and shown, since they skip it all.
  const bypassActors = existing.body.bypass_actors?.length ?? 0;
  const found = {
    url: page(ours.id),
    ...(bypassActors > 0 ? { bypassActors } : {}),
  };
  if (!strengthened) return { state: "active", ...found };
  if (!apply) return { state: "incomplete", ...found };
  const updated = await githubCall({
    token,
    url: `${base}/rulesets/${ours.id}`,
    method: "PUT",
    body: strengthened,
  });
  if (!updated.ok) return unavailable(updated);
  return { state: "active", ...found };
}

/**
 * Delete Archestra's ruleset, and take its check out of any other ruleset
 * that requires it: once the check is no longer posted, a rule that requires
 * it would hold every pull request for good. A ruleset of the repository's
 * own keeps its other rules.
 */
async function removeGithubBranchRules(source: {
  organizationId: string;
  repo: string;
  githubAppConfigId: string | null;
  githubPatId: string | null;
}) {
  const checkName = POLICY_CHECK_NAME;
  let access: Awaited<ReturnType<typeof resolveOpenAppaGithubAccess>>;
  try {
    access = await resolveOpenAppaGithubAccess(source, {
      administration: "write",
    });
  } catch (error) {
    if (!(error instanceof MissingGithubPermission)) throw error;
    // An App without Administration never wrote a ruleset: nothing to take off.
    logger.debug(
      { organizationId: source.organizationId, repo: source.repo },
      `OpenAPPA cannot take its ruleset off the policy repository: ${error.message}`,
    );
    return;
  }
  const { token, api } = access;
  if (!token) return;
  const base = `${api}/repos/${source.repo}`;
  const rulesets = await githubCall<
    Array<{ id: number; name: string; source_type?: string }>
  >({ token, url: `${base}/rulesets?includes_parents=false&per_page=100` });
  if (!rulesets.ok) throw new ApiError(502, unavailable(rulesets).detail);
  const integrationId = await checkIntegrationId(source);
  for (const candidate of rulesets.body
    .filter((ruleset) => (ruleset.source_type ?? "Repository") === "Repository")
    .slice(0, 25)) {
    const read = await githubCall<Ruleset>({
      token,
      url: `${base}/rulesets/${candidate.id}`,
    });
    if (!read.ok) continue;
    const ours =
      candidate.name === checkName ||
      (integrationId !== undefined &&
        isOurRulesetShape(read.body.rules, integrationId));
    const requires =
      requiresPolicyCheck(read.body.rules, checkName) ||
      (integrationId !== undefined &&
        requiresOurCheck(read.body.rules, integrationId));
    if (!ours && !requires) continue;
    const written = ours
      ? await githubCall({
          token,
          url: `${base}/rulesets/${candidate.id}`,
          method: "DELETE",
        })
      : await githubCall({
          token,
          url: `${base}/rulesets/${candidate.id}`,
          method: "PUT",
          body: withoutPolicyCheck(read.body, integrationId, checkName),
        });
    // Already gone: the same outcome.
    if (!written.ok && written.status !== 404)
      throw new ApiError(502, unavailable(written).detail);
  }
}

/** Whether a rule requires a check this App posts, under any name. */
function requiresOurCheck(
  rules: Rule[] | undefined,
  integrationId: number,
): boolean {
  return (rules ?? []).some(
    (rule) =>
      rule.type === "required_status_checks" &&
      (
        (rule.parameters?.required_status_checks ?? []) as Array<{
          integration_id?: number;
        }>
      ).some((check) => check.integration_id === integrationId),
  );
}

/**
 * A ruleset without the policy check: the check taken out of its required
 * checks, and the rule taken out when nothing else was required.
 */
function withoutPolicyCheck(
  existing: Ruleset,
  integrationId: number | undefined,
  checkName: string,
): Ruleset {
  const rules = (existing.rules ?? []).flatMap((rule) => {
    if (rule.type !== "required_status_checks") return [rule];
    const checks = (rule.parameters?.required_status_checks ?? []) as Array<{
      context?: string;
      integration_id?: number;
    }>;
    const kept = checks.filter(
      (check) =>
        check.context !== checkName &&
        (integrationId === undefined || check.integration_id !== integrationId),
    );
    if (kept.length === 0) return [];
    return [
      {
        type: rule.type,
        parameters: { ...rule.parameters, required_status_checks: kept },
      },
    ];
  });
  return {
    name: existing.name,
    target: existing.target,
    enforcement: existing.enforcement,
    conditions: existing.conditions,
    bypass_actors: existing.bypass_actors ?? [],
    rules,
  };
}

/**
 * Whether the source's credential may post the policy check: a token posts
 * a commit status; a GitHub App needs Checks and Pull requests, and one not
 * granted them says so.
 */
async function policyCheckAccess(
  source: ConnectedSource,
  checkName: string,
): Promise<{ postable: true } | { postable: false; detail: string }> {
  if (!source.githubAppConfigId) return { postable: true };
  try {
    await resolveOpenAppaGithubAccess(source, {
      pull_requests: "read",
      checks: "write",
    });
    return { postable: true };
  } catch (error) {
    if (error instanceof MissingGithubPermission)
      return {
        postable: false,
        detail: `The GitHub App cannot post the ${checkName} check: ${error.message}`,
      };
    throw error;
  }
}

/**
 * Whether a ruleset has the shape Archestra writes, under any name: one
 * rule, the check required from this App and nothing else. A ruleset of the
 * repository's own that requires the check among other things is theirs.
 */
function isOurRulesetShape(
  rules: Rule[] | undefined,
  integrationId: number,
): boolean {
  const [rule, ...rest] = rules ?? [];
  if (!rule || rest.length > 0 || rule.type !== "required_status_checks")
    return false;
  const checks = (rule.parameters?.required_status_checks ?? []) as Array<{
    integration_id?: number;
  }>;
  return checks.length === 1 && checks[0]?.integration_id === integrationId;
}

/** Whether a rule requires the policy check, under any App. */
function requiresPolicyCheck(
  rules: Rule[] | undefined,
  checkName: string,
): boolean {
  return (rules ?? []).some(
    (rule) =>
      rule.type === "required_status_checks" &&
      (
        (rule.parameters?.required_status_checks ?? []) as Array<{
          context?: string;
        }>
      ).some((check) => check.context === checkName),
  );
}

/**
 * The ruleset Archestra keeps: one rule, the policy check required from this
 * App, so a pull request that would break the policy, or change a server's
 * rules without its editor asking, cannot merge. Nothing else about the
 * branch is Archestra's: pull requests, reviews, pushes and history are the
 * repository's to rule, and a repository that holds other work beside the
 * policy sees no other change. The check posts on every pull request and is
 * skipped when no policy file changed, so the rule holds nobody up. Archestra
 * adds no one who may bypass it, itself included.
 */
function desiredRuleset(params: {
  branch: string;
  integrationId?: number;
  checkName: string;
}): Ruleset & { bypass_actors: unknown[]; rules: Rule[] } {
  return {
    name: params.checkName,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: [`refs/heads/${params.branch}`], exclude: [] },
    },
    bypass_actors: [],
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: [
            {
              context: params.checkName,
              // Only this App's check counts: no one posts a passing one
              // with a token of their own.
              ...(params.integrationId
                ? { integration_id: params.integrationId }
                : {}),
            },
          ],
        },
      },
    ],
  };
}

/**
 * The existing ruleset with Archestra's rule added where missing, turned
 * back on where turned off, or null when it is in order. What an
 * administrator added stays, bypass entries included; an exclusion that
 * leaves the synced branch out does not. To be rid of the ruleset, turn
 * self-service off: that takes it away.
 */
function strengthenedRuleset(
  existing: Ruleset,
  desired: ReturnType<typeof desiredRuleset>,
  branch: { ref: string; isDefault: boolean },
): Ruleset | null {
  let changed = false;
  const rules = [...(existing.rules ?? [])].map((rule) => ({
    type: rule.type,
    ...(rule.parameters ? { parameters: rule.parameters } : {}),
  }));
  for (const wanted of desired.rules) {
    const at = rules.findIndex((rule) => rule.type === wanted.type);
    const have = rules[at];
    if (!have) {
      rules.push(wanted);
      changed = true;
      continue;
    }
    if (wanted.type === "required_status_checks") {
      const ours = (
        wanted.parameters?.required_status_checks as Array<{
          context: string;
          integration_id?: number;
        }>
      )[0] as { context: string; integration_id?: number };
      const checks = (have.parameters?.required_status_checks ?? []) as Array<{
        context: string;
        integration_id?: number;
      }>;
      const present = checks.some(
        (check) =>
          check.context === ours.context &&
          (ours.integration_id === undefined ||
            check.integration_id === ours.integration_id),
      );
      // A check this App posted under an earlier name is ours, renamed.
      const renamed = checks.filter(
        (check) =>
          ours.integration_id !== undefined &&
          check.integration_id === ours.integration_id &&
          check.context !== ours.context,
      );
      // Whether the branch must be up to date is the repository's choice.
      if (!present || renamed.length > 0) {
        const kept = checks.filter(
          (check) => check.context !== ours.context && !renamed.includes(check),
        );
        rules[at] = {
          type: have.type,
          parameters: {
            strict_required_status_checks_policy: false,
            ...have.parameters,
            required_status_checks: [...kept, ours],
          },
        };
        changed = true;
      }
    }
  }
  // The synced branch is protected when an include names it and no
  // exclusion takes it out again.
  const include = existing.conditions?.ref_name?.include ?? [];
  const exclude = existing.conditions?.ref_name?.exclude ?? [];
  const names = (pattern: string) => refPatternMatches(pattern, branch);
  const covers = include.some(names);
  const kept = exclude.filter((pattern) => !names(pattern));
  if (!covers || kept.length < exclude.length) changed = true;
  if (existing.name !== desired.name) changed = true;
  if (existing.enforcement !== "active") changed = true;
  if (!changed) return null;
  return {
    name: desired.name,
    target: existing.target,
    enforcement: "active",
    conditions: {
      ref_name: {
        include: covers ? include : [...include, branch.ref],
        exclude: kept,
      },
    },
    bypass_actors: existing.bypass_actors ?? [],
    rules,
  };
}

/**
 * Whether a ruleset's ref pattern names the branch, as GitHub reads one:
 * `~ALL`, `~DEFAULT_BRANCH`, or an fnmatch pattern over the full ref, where
 * `*` and `?` stay within one path segment and `**` crosses segments.
 */
function refPatternMatches(
  pattern: string,
  branch: { ref: string; isDefault: boolean },
): boolean {
  if (pattern === "~ALL") return true;
  if (pattern === "~DEFAULT_BRANCH") return branch.isDefault;
  let source = "";
  for (let at = 0; at < pattern.length; at++) {
    const char = pattern[at] as string;
    if (char === "*" && pattern[at + 1] === "*") {
      source += ".*";
      at++;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else if (char === "[" && pattern.indexOf("]", at + 2) > at) {
      const close = pattern.indexOf("]", at + 2);
      const set = pattern.slice(at + 1, close).replace(/[\\^]/g, "\\$&");
      source += set.startsWith("!") ? `[^${set.slice(1)}]` : `[${set}]`;
      at = close;
    } else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${source}$`).test(branch.ref);
  } catch {
    return false;
  }
}

/** The App whose check the ruleset requires, or none for a token. */
async function checkIntegrationId(source: {
  organizationId: string;
  githubAppConfigId: string | null;
}): Promise<number | undefined> {
  if (!source.githubAppConfigId) return undefined;
  const definition = await RuntimeCredentialDefinitionModel.findById({
    id: source.githubAppConfigId,
    organizationId: source.organizationId,
  });
  const id = Number(definition?.appId);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** A refusal GitHub explains: a plan without rulesets, or a missing permission. */
function unavailable(response: {
  status: number;
  message?: string;
}): RepositoryProtection["branchRules"] & { detail: string } {
  return {
    state:
      response.status === 403 || response.status === 404
        ? "unavailable"
        : "error",
    detail: response.message
      ? `GitHub answered ${response.status}: ${response.message}`
      : `GitHub answered ${response.status}`,
  };
}

// === GitHub calls ===

async function defaultBranch(params: { token: string; base: string }) {
  return (
    await githubJson<{ default_branch: string }>({
      token: params.token,
      url: params.base,
      errors: githubSyncErrors,
    })
  ).default_branch;
}

/**
 * One GitHub request whose refusal the caller reads: the status and GitHub's
 * own message rather than an error.
 */
async function githubCall<T = unknown>(params: {
  token: string;
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: object;
}): Promise<
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; message?: string }
> {
  let response: Response;
  try {
    response = await githubFetch({ ...params, apiVersion: true });
  } catch (err) {
    logger.warn({ err }, "OpenAPPA could not reach GitHub");
    throw new ApiError(502, "Could not reach GitHub");
  }
  const bytes = await readResponseBodyWithLimit(response, 2 * 1024 * 1024);
  let parsed: unknown = null;
  try {
    parsed = bytes && bytes.length > 0 ? JSON.parse(bytes.toString()) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const message = asRecord(parsed)?.message;
    return {
      ok: false,
      status: response.status,
      ...(typeof message === "string"
        ? { message: message.slice(0, 300) }
        : {}),
    };
  }
  return { ok: true, status: response.status, body: parsed as T };
}
