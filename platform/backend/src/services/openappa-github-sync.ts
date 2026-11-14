import { createHash, randomUUID } from "node:crypto";
import {
  getGithubWebOrigin,
  gitHostFromUrl,
  isBuiltInCatalogId,
  parseFullToolName,
  slugifyMcpServerName,
  TimeInMs,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { userHasPermission } from "@/auth";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import config, {
  OPENAPPA_SELF_SERVICE_AUTO_MERGE_VARIABLE,
  OPENAPPA_SELF_SERVICE_DIRECTORY_VARIABLE,
  OPENAPPA_SELF_SERVICE_VARIABLE,
} from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import { gitClient } from "@/git-hosts/git-access";
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
import UserModel from "@/models/user";
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
  isServerRulesBranch,
  isServerRulesFile,
  isServerRulesFolder,
  repositoryIncludePaths,
  requesterOf,
  SELF_SERVICE_INCLUDE_BRANCH,
  serverRulesInclude,
  serverRulesPrefix,
  withIncludeEntry,
  withoutRepositoryIncludes,
  withRequester,
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
  firstFileAtEachPath,
  githubAppLogin,
  githubAppProfile,
  hasRepositoryIncludeGlob,
  MissingGithubPermission,
  openappaRepositoryIncludes,
  type RepositorySource,
  rememberSetupCommit,
  repositoryPath,
  resolveOpenAppaGithubAccess,
  resolveOpenAppaGitlabAccess,
  strayGlobMatches,
  templateExampleBlob,
} from "@/services/openappa-github-access";
import { openappaGitlab } from "@/services/openappa-gitlab";
import {
  driftedTemplateFiles,
  forgetTemplateFilesState,
  getTemplateFilesState,
  maintainTemplateFiles,
  templateFilesApply,
} from "@/services/openappa-template-files";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import type {
  AppaGithubSource,
  AppaPolicyCheck,
} from "@/types/openappa-github-sync";
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
  const [templateFiles, check] = await Promise.all([
    row.repo ? getTemplateFilesState(organizationId) : undefined,
    policyCheckState(row),
  ]);
  return {
    enabled: enterpriseTier.isOpenappaActive(),
    source,
    selfService: { ...selfServiceState(), ...(await leftoverRule(row)) },
    hasPolicy: content !== null,
    validationDirectory,
    githubWebUrl,
    provider,
    ...(templateFiles ? { templateFiles } : {}),
    ...(check ? { check } : {}),
  };
}

/**
 * The policy check as the settings show it: posted on every pull request of
 * a GitHub App source, or refused by GitHub for a permission the App lacks,
 * which the last round of checks recorded.
 */
async function policyCheckState(
  row: SyncRow,
): Promise<AppaPolicyCheck | undefined> {
  if (!row.repo || !row.interval) return undefined;
  const name = POLICY_CHECK_NAME;
  if (!row.githubAppConfigId) return { name, state: "none" };
  const refused = await cacheManager
    .get<{ reason?: string } | true>(
      refusedChecksKey(row.organizationId, row.repo),
    )
    .catch(() => undefined);
  if (!refused) return { name, state: "posted" };
  return {
    name,
    state: "refused",
    ...(typeof refused === "object" && refused.reason
      ? { detail: refused.reason }
      : {}),
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
    autoMerge: autoMergeState(),
  };
}

/**
 * Whether the GitHub App merges each self-served rules pull request once its
 * policy check passes, and the variable that decides it. Release 1.4 reads it
 * from the environment, off by default; later releases save it with the
 * source and, while the variable is set, use it instead.
 */
function autoMergeState() {
  const value = config.openappa.selfServiceAutoMerge;
  return {
    enabled: value === "enabled",
    environment: { variable: OPENAPPA_SELF_SERVICE_AUTO_MERGE_VARIABLE, value },
  };
}

/**
 * Whether self-service is in force on a source: on, and a GitHub App
 * source that syncs, since the policy check is the App's and the branch
 * ruleset requires it from the App. A token or a GitLab source never gets
 * them.
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

/**
 * Whether the GitHub App merges each self-served rules pull request once its
 * policy check passes: on, with self-service in force on the source.
 */
export function selfServiceAutoMergeActive(row: SyncRow | null): boolean {
  return selfServiceActive(row) && autoMergeState().enabled;
}

/** Whether self-service is in force on the organization's saved source. */
export async function selfServiceInForce(organizationId: string) {
  return selfServiceActive(await OpenAppaGithubSyncModel.find(organizationId));
}

/**
 * Whether self-service is set up in full, which is when the registry offers
 * its action and the Keeper's server rules tools work: on by the variable,
 * a GitHub App source that has synced, the servers' folder included by the
 * accepted policy, and the branch ruleset active with a check the App can
 * post: a required check nobody posts would hold every pull request the
 * editors open. Before that, Finish setup on the Git sync card completes it;
 * the ruleset's state is the protection read the card shows, kept for a
 * minute and replaced by each sync.
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
  return (
    protection?.branchRules.state === "active" &&
    protection.branchRules.checkRule !== "unposted"
  );
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
  // A rule on the branch left behind refuses the move before anything is
  // created on GitHub; the save checks again with the branch resolved.
  await beforeSourceChange(params.organizationId, {
    repo: `${params.owner}/${params.name}`,
    ref: params.ref ?? null,
    githubAppConfigId,
  });
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
  // is written, so a transfer that cannot be complete creates nothing. The
  // seed's include list decides, so a servers' folder the seed starts
  // including comes along with the files already in it.
  const transfer = await collectSetupTransfer({
    organizationId: params.organizationId,
    seed,
    current: policy.content,
  });

  let created: {
    full_name?: string;
    default_branch?: string;
    private?: boolean;
  };
  const repo = `${params.owner}/${params.name}`;
  let setupPullRequestNumber: number | undefined;
  let setupCommit: string | undefined;
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
    setupCommit = seeded.setupCommit;
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
        userId: params.userId,
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
      const parent = await branchHead({ base, token, branch, setup: true });
      // A copy made from an older template gets the current files too, so
      // its checks work from the first pull request.
      const files = firstFileAtEachPath([
        { path: "appa.toml", content: seed },
        ...transferredFiles(transfer, {
          path: "appa.toml",
          validationDirectory,
        }),
        ...(templateFilesApply({ path: "appa.toml", validationDirectory })
          ? await driftedTemplateFiles((path) =>
              githubFileAt({ base, token, commit: parent, path }),
            )
          : []),
      ]);
      // The template's own example is replaced in one commit with the current
      // policy and what it reads beside it; identical bytes need no commit.
      // A copy that already holds files the policy's globs would read, and
      // that were never in the policy, loses them in the same commit.
      const outcome = await commitSetupFiles({
        base,
        token,
        branch,
        parent,
        files,
        remove: await regularStrayFilesToRemove({
          base,
          token,
          commit: parent,
          content: seed,
          policyPath: "appa.toml",
          files,
        }),
        message: await setupMessage(params.userId),
        pull: {
          title: SETUP_TITLE,
          body: setupPullBody(transfer, false, "github"),
        },
        direct: true,
      });
      setupPullRequestNumber = outcome.setupPullRequestNumber;
      setupCommit = outcome.setupCommit;
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
  if (setupPullRequestNumber && setupCommit)
    await rememberSetupCommit({
      organizationId: params.organizationId,
      host: "github",
      api,
      repo,
      number: setupPullRequestNumber,
      sha: setupCommit,
    });
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
  userId: string;
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
  let setupCommit: string | undefined;
  let branch = params.ref;
  try {
    branch ??= await defaultBranch({ token, base });
    const parent = await branchHead({ base, token, branch });
    const validationDirectory =
      params.source.validationDirectory ?? VALIDATION_DIRECTORY;
    // The files beside the policy that this version ships, where the
    // repository lacks them or holds older ones: the pull request that brings
    // the policy brings its checks too, so they pass from the first review.
    const files = firstFileAtEachPath([
      { path, content: params.seed },
      ...transferredFiles(params.transfer, { path, validationDirectory }),
      ...(templateFilesApply({ path, validationDirectory })
        ? await driftedTemplateFiles((file) =>
            githubFileAt({ base, token, commit: parent, path: file }),
          )
        : []),
    ]);
    const outcome = await commitSetupFiles({
      base,
      token,
      branch,
      parent,
      files,
      // Files the repository holds that the policy's globs would read, and
      // that were never in the policy, go in the same commit.
      remove: await regularStrayFilesToRemove({
        base,
        token,
        commit: parent,
        content: params.seed,
        policyPath: path,
        files,
      }),
      message: await setupMessage(params.userId),
      pull: {
        title: SETUP_TITLE,
        body: setupPullBody(params.transfer, true, "github"),
      },
      direct: false,
    });
    setupPullRequestNumber = outcome.setupPullRequestNumber;
    setupCommit = outcome.setupCommit;
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
    // A pull request merges into the branch it was opened against: the
    // source follows that branch, not a default that may move meanwhile.
    ref: setupPullRequestNumber ? branch : params.ref,
    path,
    githubPatId: null,
    gitlabTokenId: null,
    setupPullRequestNumber,
  };
  await beforeSourceChange(params.organizationId, source);
  await OpenAppaGithubSyncModel.save(params.organizationId, source);
  if (setupPullRequestNumber && setupCommit)
    await rememberSetupCommit({
      organizationId: params.organizationId,
      host: "github",
      api,
      repo,
      number: setupPullRequestNumber,
      sha: setupCommit,
    });
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
  // A GitLab project in a GitHub App's place posts no check: a rule on the
  // branch left behind refuses the move before the project is created.
  await beforeSourceChange(params.organizationId, {
    repo: params.owner ? `${params.owner}/${params.name}` : params.name,
    ref: params.ref ?? null,
  });
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
    seed: policy.content,
    current: policy.content,
  });
  const repo = params.owner ? `${params.owner}/${params.name}` : params.name;
  let seeded: {
    repo: string;
    branch: string | null;
    path?: string;
    setupPullRequestNumber?: number;
    setupCommit?: string;
  };
  // A project with a policy of its own is connected as a source: a first
  // pull that fails leaves the sync stopped, as connecting does.
  let holdsPolicy = false;
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
      holdsPolicy = true;
      const path = params.path ?? "appa.toml";
      // The files beside the policy that this version ships, where the
      // project lacks them or holds older ones, go with the proposal.
      const client = gitClient(access);
      const branch =
        params.ref ?? (await openappaGitlab.defaultBranch({ access, repo }));
      const proposed = await openappaGitlab.proposeSetup({
        access,
        repo,
        ref: params.ref ?? null,
        policyPath: path,
        content: policy.content,
        files: [
          { path, content: policy.content },
          ...transferredFiles(transfer, { path, validationDirectory }),
          ...(templateFilesApply({ path, validationDirectory })
            ? await driftedTemplateFiles(async (file) => {
                const bytes = await client.readFile({
                  repo,
                  ref: branch,
                  path: file,
                  maxBytes: 256 * 1024,
                });
                return bytes ? bytes.toString("utf8") : null;
              })
            : []),
        ],
        title: "Seed current OpenAPPA policy",
        summary: setupPullBody(transfer, true, "gitlab"),
      });
      seeded = {
        repo,
        // A merge request merges into the branch it was opened against.
        branch: proposed ? proposed.branch : (params.ref ?? null),
        path,
        setupPullRequestNumber: proposed?.iid,
        setupCommit: proposed?.sha,
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
  if (seeded.setupPullRequestNumber && seeded.setupCommit)
    await rememberSetupCommit({
      organizationId: params.organizationId,
      host: "gitlab",
      api: access.host.apiUrl,
      repo: seeded.repo,
      number: seeded.setupPullRequestNumber,
      sha: seeded.setupCommit,
    });
  await syncAppaGithubPolicy(params.organizationId);
  const row = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (holdsPolicy && row?.lastSyncError) {
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
    // A stopped sync posts no check: a rule that still requires it would
    // hold every pull request, so the stop waits for the rule's removal.
    if (params.action === "disconnect")
      await beforeSourceChange(params.organizationId, null);
    await OpenAppaGithubSyncModel.setInterval(
      params.organizationId,
      params.action === "disconnect" ? null : (params.interval ?? row.interval),
    );
    // A new schedule counts from a pull now.
    if (params.action === "schedule")
      await OpenAppaGithubSyncModel.enqueue(params.organizationId);
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
      // The branch rules are read all the same: the ruleset is imported
      // while the setup pull request waits, and the variable may be turned
      // off meanwhile.
      await readProtectionAfterSync(organizationId);
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
    // The files beside the policy, from this version's template: what
    // differs at the accepted commit is proposed as a pull request. Never
    // fails the pull; the outcome shows in the Git sync settings.
    await maintainTemplateFiles({
      ...row,
      repo,
      path,
      sourceCommit: commit.sha,
    });
  } catch (error) {
    logger.warn({ err: error, organizationId }, "OpenAPPA GitHub sync failed");
    // Never persist raw transport/native diagnostics, which can contain
    // credentials or policy bytes. A host unreachable for now is named as
    // such, so a status that follows a merge knows to wait for the next pull.
    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: row.revision,
      outcome: {
        error:
          error instanceof ApiError
            ? error.message
            : isTransportError(error)
              ? "Could not reach GitHub to sync the APPA policy. Git sync tries again at its next check."
              : "Could not sync the APPA policy. Check the repository, file, and GitHub credential, then retry.",
      },
    });
  }
  await readProtectionAfterSync(organizationId);
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
/**
 * Every sync also reads the repository's protection for server rules files:
 * whether a branch rule requires the policy check. A failure there shows in
 * the protection status and never fails the pull.
 */
async function readProtectionAfterSync(organizationId: string) {
  let protection: RepositoryProtection | null = null;
  try {
    protection = await maintainRepositoryProtection(organizationId);
  } catch (error) {
    logger.warn(
      { organizationId, error },
      "OpenAPPA could not read the policy repository's protection",
    );
  }
  // What self-service still needs from the policy file is proposed at once,
  // as the template's files are: the include of the servers' folder waits
  // in the Git sync setup as a pull request, never as a step that asks for
  // one. An accepted policy that includes it costs no request to GitHub.
  // Never fails the pull.
  if (!protection) return;
  try {
    // The server rules service imports this module: it loads on first use.
    const { proposeSelfServiceInclude } = await import(
      "@/services/openappa-server-rules"
    );
    if (await proposeSelfServiceInclude(organizationId))
      await maintainRepositoryProtection(organizationId);
  } catch (error) {
    logger.warn(
      { organizationId, error },
      "OpenAPPA could not propose the include of the self-service folder",
    );
  }
}

export async function checkDueAppaGithubSyncs() {
  if (!enterpriseTier.isOpenappaActive()) return;
  for (const row of await OpenAppaGithubSyncModel.findDue())
    await OpenAppaGithubSyncModel.enqueue(row.organizationId);
  // Open pull requests get a pull's checks every minute, before they merge,
  // on every repository read through a GitHub App: the setup pull request
  // included, since the policy it carries is the first one checked.
  await mapWithConcurrency(
    await OpenAppaGithubSyncModel.findGithubAppSources(),
    4,
    async (row) => {
      try {
        // Release 1.4: self-service is the deployment's variable, so no
        // event marks it turned off. A rule it left behind is read for at
        // the minute's round, so the settings name it at once rather than
        // at the next sync, which may be a day away.
        if (!selfServiceActive(row)) await recordLeftoverRuleSoon(row);
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
 * ruleset an administrator imports to require it:
 * ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME. A renamed deployment posts the check
 * under the new name; the imported rule is edited by hand to match.
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

/**
 * How long a self-served pull request GitHub refused to merge twice is left
 * to people before the App tries again at the same head. The first refusal
 * is tried again the next minute: a check just posted can take GitHub a
 * moment to count against the branch rules. The same hold applies to a
 * repository whose App cannot merge at all.
 */
export const RETRY_REFUSED_MERGE = 15 * TimeInMs.Minute;

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
  /**
   * What the pull request changes that Git sync reads, whether it may, and
   * whether it is self-served: one MCP server's rules, opened by this
   * deployment's App for a member who may change them.
   */
  judged: Verdict & { governed: string[]; selfServed: boolean };
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
 *
 * With auto-merge in force, a self-served pull request whose check passed is
 * merged through the App right after, and on later passes while it stays
 * open, so a merge that failed for now is tried again.
 */
async function checkAppaGithubPullRequests(organizationId: string) {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row?.repo || !row.path || !row.interval || !row.githubAppConfigId)
    return;
  const source = { ...row, repo: row.repo, path: row.path };
  const refused = refusedChecksKey(organizationId, source.repo);
  if (await cacheManager.get(refused)) return;
  // A merge whose pull was not queued (the process stopped in between) is
  // followed up here: the marker set before the merge is still there.
  if (
    await cacheManager
      .get(pendingResyncKey(organizationId, source.repo))
      .catch(() => null)
  )
    await queueSyncAfterMerge(organizationId, source.repo);
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
  const deployment = await deploymentState(
    organizationId,
    row.sourceCommit ?? "",
  );
  const checking = pulls.slice(0, MAX_CHECKED_PULLS);
  const merger = selfServiceAutoMergeActive(row)
    ? new AutoMerger(source)
    : null;
  // What the source reads decides which files a pull request governs, so a
  // policy file or servers' folder moved makes every stored result stale,
  // the unrelated ones included.
  const keys = checking.map((pull) => checkedResultKey(source, pull));
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
    if (judgedStands && policyStands) {
      await merger?.mergeIfDue({ pull, result: previous, key });
      continue;
    }
    const judged = judgedStands
      ? previous.judged
      : await (async () => {
          const read: Judged | null = pull.judge
            ? await pull.judge()
            : // A host that cannot tell: check the policy for every request.
              {
                governed: ["*"],
                outcome: { accepted: true },
                selfServed: false,
              };
          const made = verdict(read?.outcome ?? null, { checkedAt: now });
          return made && read
            ? { ...made, governed: read.governed, selfServed: read.selfServed }
            : null;
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
    // The verdict stands on GitHub now: a later off round posts skipped over it.
    await cacheManager
      .delete(
        checkKey("leftover-posted", organizationId, source.repo, pull.head),
      )
      .catch(() => undefined);
    await cacheManager
      .set(key, result, CHECKED_TTL)
      .catch((err) =>
        logger.warn(
          { organizationId, err },
          "OpenAPPA could not record a posted policy check; the next pass checks it again",
        ),
      );
    await merger?.mergeIfDue({ pull, result, key });
  }
}

/**
 * Merges self-served pull requests through the App while auto-merge is in
 * force. The token that may write, and the merge method the repository
 * allows, are read once per pass, and only when a pull request is due.
 */
class AutoMerger {
  private access: Promise<{
    token: string;
    base: string;
    method: "merge" | "squash" | "rebase";
  } | null> | null = null;

  constructor(private readonly source: PolicySource) {}

  /** Whether the branch rules take the check from this App now, read once per pass. */
  private ruleset: Promise<boolean> | null = null;
  private rulesetFixed() {
    this.ruleset ??= protectionRead(this.source.organizationId)
      .then((read) => read?.branchRules.state === "active")
      .catch(() => false);
    return this.ruleset;
  }

  /**
   * Merge a pull request whose check passed when it is self-served, unless
   * GitHub refused it at this head: once, it is tried again the next
   * minute; more than once, fifteen minutes later.
   */
  async mergeIfDue(params: {
    pull: CheckedPull;
    result: CheckedResult;
    key: AllowedCacheKey;
  }) {
    const { pull, result } = params;
    const { organizationId, repo } = this.source;
    let refusal = await mergeRefusalOf(this.source, pull);
    // A merge the ruleset held is not left for fifteen minutes once the
    // ruleset is fixed on GitHub: each minute reads the branch rules again,
    // and the merge goes ahead as soon as they take the check from this App.
    if (refusal?.ruleset && (await this.rulesetFixed())) {
      await forgetRulesetRefusals(organizationId, repo);
      refusal = undefined;
    }
    const skipped = !result.accepted
      ? "its check did not pass"
      : result.judged.governed.length === 0
        ? "it changes no policy file"
        : !result.judged.selfServed
          ? "it is not self-served"
          : !pull.number || !pull.ref || !isServerRulesBranch(pull.ref)
            ? "it is not on a server rules branch"
            : refusal &&
                Date.now() - refusal.at <
                  // A ruleset that takes the check from another App waits
                  // for its fix, which forgets the refusal; a first refusal
                  // of another kind is tried again next minute.
                  (refusal.ruleset || refusal.count > 1
                    ? RETRY_REFUSED_MERGE
                    : 0)
              ? "GitHub refused it a moment ago"
              : null;
    if (skipped) {
      logger.debug(
        { organizationId, repo, number: pull.number, reason: skipped },
        "OpenAPPA is not merging this pull request",
      );
      return;
    }
    this.access ??= this.resolveAccess();
    const access = await this.access;
    if (!access) return;
    // Every check on the pull request must have passed, not only this one:
    // GitHub enforces only the checks a rule requires, and the repository's
    // own workflow is rarely one of them.
    const readiness = await mergeReadiness({
      token: access.token,
      base: access.base,
      number: pull.number as number,
      head: pull.head,
      ...(pull.openedAt !== undefined ? { openedAt: pull.openedAt } : {}),
    }).catch(() => ({ state: "waiting" as const, waitingFor: [] }));
    if (readiness.state !== "ready") {
      logger.debug(
        { organizationId, repo, number: pull.number, readiness },
        "OpenAPPA waits for the pull request's other checks before merging it",
      );
      return;
    }
    const merged = await githubCall<{ merged?: boolean }>({
      token: access.token,
      url: `${access.base}/pulls/${pull.number}/merge`,
      method: "PUT",
      body: { sha: pull.head, merge_method: access.method },
    }).catch((error: unknown) => ({ ok: false as const, status: 0, error }));
    if (merged.ok) {
      logger.info(
        { organizationId, repo, number: pull.number },
        "OpenAPPA merged a self-served Guardrails rules pull request",
      );
      // A pull applies the merge now rather than at the next schedule.
      await noteSyncOwed(organizationId, repo);
      await queueSyncAfterMerge(organizationId, repo);
      const deleted = await githubFetch({
        url: `${access.base}/git/refs/heads/${pull.ref}`,
        token: access.token,
        method: "DELETE",
      }).catch(() => null);
      if (!deleted?.ok)
        logger.debug(
          { organizationId, status: deleted?.status, branch: pull.ref },
          "OpenAPPA could not delete a merged rules branch",
        );
      return;
    }
    if ([403, 404, 405, 409, 422].includes(merged.status)) {
      // Merged or closed by someone since the listing: nothing to refuse.
      const gone = await this.settledMeanwhile(pull, access);
      if (gone) return;
      // Another rule blocks it, its head moved, it cannot merge cleanly, or
      // the App may not merge here: people take it from here, and the App
      // tries again in a while.
      logger.warn(
        {
          organizationId,
          repo,
          number: pull.number,
          status: merged.status,
          message: "message" in merged ? merged.message : undefined,
        },
        "GitHub refused to merge a self-served Guardrails rules pull request; it is left for people, and tried again later",
      );
      await recordMergeRefusal(this.source, pull, {
        ...explainMergeRefusal(merged),
        count: (refusal?.count ?? 0) + 1,
      });
      return;
    }
    logger.warn(
      {
        organizationId,
        repo,
        number: pull.number,
        status: merged.status,
        ...("error" in merged ? { err: merged.error } : {}),
      },
      "OpenAPPA could not merge a self-served Guardrails rules pull request; it tries again next minute",
    );
  }

  /**
   * Whether the pull request was merged or closed between the listing and
   * the merge: a merge by someone else is followed by a pull like the App's
   * own; a closed one is left alone. False while it is still open, or when
   * GitHub cannot say for now (the refusal is then recorded as such).
   */
  private async settledMeanwhile(
    pull: CheckedPull,
    access: { token: string; base: string },
  ): Promise<boolean> {
    const { organizationId, repo } = this.source;
    const read = await githubCall<{ state?: string; merged?: boolean }>({
      token: access.token,
      url: `${access.base}/pulls/${pull.number}`,
    }).catch(() => null);
    if (!read?.ok) return false;
    if (read.body.merged === true) {
      logger.info(
        { organizationId, repo, number: pull.number },
        "A self-served Guardrails rules pull request was merged by someone else meanwhile",
      );
      await noteSyncOwed(organizationId, repo);
      await queueSyncAfterMerge(organizationId, repo);
      return true;
    }
    if (read.body.state && read.body.state !== "open") {
      logger.info(
        { organizationId, repo, number: pull.number },
        "A self-served Guardrails rules pull request was closed meanwhile",
      );
      return true;
    }
    return false;
  }

  private async resolveAccess() {
    const { organizationId, repo } = this.source;
    const held = heldMergesKey(organizationId, repo);
    // A repository the App cannot merge in is not asked again every minute.
    if (await cacheManager.get(held).catch(() => null)) return null;
    const hold = (reason: string) =>
      cacheManager
        .set(held, reason, RETRY_REFUSED_MERGE)
        .catch((err) =>
          logger.warn(
            { organizationId, err },
            "OpenAPPA could not record a held merge",
          ),
        );
    try {
      const { token, api } = await resolveOpenAppaGithubAccess(this.source, {
        contents: "write",
        pull_requests: "write",
        // Every check on a pull request is read before it merges.
        checks: "read",
      });
      if (!token) return null;
      const base = `${api}/repos/${this.source.repo}`;
      const repository = await githubJson<{
        allow_merge_commit?: boolean;
        allow_squash_merge?: boolean;
        allow_rebase_merge?: boolean;
      }>({
        url: base,
        token,
        // A refusal is the App's permissions; anything else is GitHub's for now.
        errors: async ({ status }) =>
          new ApiError(
            [401, 403, 404].includes(status) ? 403 : 502,
            `GitHub returned HTTP ${status} reading the repository`,
          ),
      });
      // A merge commit keeps the signed commit the check read; squash and
      // rebase follow where the repository allows only those.
      const method =
        repository.allow_merge_commit !== false
          ? ("merge" as const)
          : repository.allow_squash_merge !== false
            ? ("squash" as const)
            : repository.allow_rebase_merge !== false
              ? ("rebase" as const)
              : null;
      if (!method) {
        logger.warn(
          { organizationId, repo },
          "The policy repository allows no merge method; self-served pull requests are left for people",
        );
        await hold(HELD_NO_MERGE_METHOD);
        return null;
      }
      return { token, base, method };
    } catch (error) {
      // GitHub failing for now is asked again next minute. A permission the
      // App lacks is held as such; a credential that cannot be used (gone,
      // or without its key) is held with its own words, so nobody is sent
      // to grant a permission the App may well have.
      const permission =
        error instanceof MissingGithubPermission ||
        (error instanceof ApiError && error.statusCode === 403);
      const credential =
        !permission &&
        error instanceof ApiError &&
        error.statusCode < 500 &&
        error.statusCode !== 403;
      logger.warn(
        { organizationId, repo, error },
        permission
          ? "OpenAPPA cannot merge self-served pull requests: the GitHub App needs Contents and Pull requests write"
          : credential
            ? "OpenAPPA cannot merge self-served pull requests: the GitHub App credential cannot be used"
            : "OpenAPPA could not reach GitHub to merge self-served pull requests; it tries again next minute",
      );
      if (permission) await hold(HELD_NO_PERMISSION);
      else if (credential)
        await hold(
          `the GitHub App credential cannot be used (${(error as ApiError).message}), which an administrator fixes under Settings → Guardrails → Git sync`,
        );
      return null;
    }
  }
}

/** The key under which a repository the App cannot merge in waits fifteen minutes. */
function heldMergesKey(organizationId: string, repo: string) {
  return checkKey("merge", organizationId, repo);
}

/** Why the App holds off merging in a repository, in the user's terms. */
const HELD_NO_PERMISSION =
  "the GitHub App may not merge in the repository: it needs Contents and Pull requests write and Checks read, which an administrator grants on GitHub";
const HELD_NO_MERGE_METHOD =
  "the repository allows no merge method (merge commits, squash and rebase are all off), which an administrator changes in its settings on GitHub";

/**
 * Why the App is not merging in the repository for now, if it is held off:
 * the reason recorded when it last tried, which stands for fifteen minutes.
 */
export async function heldMergeReason(source: {
  organizationId: string;
  repo: string;
}): Promise<string | null> {
  const held = await cacheManager
    .get<unknown>(heldMergesKey(source.organizationId, source.repo))
    .catch(() => null);
  return typeof held === "string" ? held : held ? HELD_NO_PERMISSION : null;
}

/** The key under which a merge still owes a pull of the synced branch. */
function pendingResyncKey(organizationId: string, repo: string) {
  return checkKey("resync", organizationId, repo);
}

/**
 * Note that a merge on the synced branch owes a pull, before the pull is
 * queued: a process that stops in between leaves the note for the next
 * minute's pass to act on. The note is the repository's, not one pull
 * request's, so only a queued pull clears it; a refusal never does.
 */
async function noteSyncOwed(organizationId: string, repo: string) {
  await cacheManager
    .set(pendingResyncKey(organizationId, repo), true, CHECKED_TTL)
    .catch((err) =>
      logger.warn(
        { organizationId, err },
        "OpenAPPA could not note the pull that is to follow a merge",
      ),
    );
}

/**
 * Queue the pull that applies a merge, and clear the note that one is owed.
 * One that cannot be queued stays noted, so the next minute's pass queues
 * it; the schedule applies the merge in any case.
 */
async function queueSyncAfterMerge(organizationId: string, repo: string) {
  try {
    // A pull queued or running already may have read the branch before this
    // merge: the note stays until one queued after the merge is in.
    if (!(await OpenAppaGithubSyncModel.enqueue(organizationId))) {
      logger.debug(
        { organizationId },
        "A pull is queued or running already; the one a merge owes is queued once it is done",
      );
      return;
    }
  } catch (err) {
    logger.warn(
      { organizationId, err },
      "OpenAPPA could not queue the pull that applies a merged rules pull request; the next minute queues it again",
    );
    return;
  }
  await cacheManager
    .delete(pendingResyncKey(organizationId, repo))
    .catch(() => null);
}

/**
 * The key a pull request's posted verdict is kept under. What the source
 * reads decides which files a pull request governs, so a policy file or
 * servers' folder moved makes every stored result stale, the unrelated ones
 * included.
 */
function checkedResultKey(
  source: PolicySource,
  pull: Pick<CheckedPull, "head" | "result">,
) {
  return checkKey(
    "checked",
    "v4",
    source.organizationId,
    source.repo,
    source.ref ?? "",
    source.path,
    configuredServerRulesFolder(),
    String(source.githubAppConfigId ?? ""),
    POLICY_CHECK_NAME,
    pull.head,
    pull.result,
  );
}

/** The conclusions a finished check passes with, as GitHub counts them. */
const PASSING = new Set(["success", "neutral", "skipped"]);

/**
 * How long a pull request opened moments ago waits before it merges: the
 * repository's own checks, a workflow among them, register a few seconds
 * after it opens, and a merge before then would not wait for them.
 */
const CHECKS_SETTLE = 30 * TimeInMs.Second;

/** Whether a self-served pull request may merge now, by every check on it. */
type MergeReadiness =
  | { state: "ready" }
  /** Checks still running, by name; none named while they register. */
  | { state: "waiting"; waitingFor: string[] }
  | { state: "failed"; failed: string[] }
  /** Held by what a person resolves on GitHub, such as a conflict or a draft. */
  | { state: "held"; reason: string };

/** The most pages of check runs read for one merge: 100 runs a page. */
const CHECK_RUN_PAGES = 10;

/**
 * Whether a self-served pull request may merge now: it neither conflicts nor
 * is a draft, every check run on its head finished and passed, and GitHub's
 * merge state counts no other check or commit status that does not pass. One
 * opened moments ago waits for its checks to register. The token reads checks
 * and pull requests.
 */
export async function mergeReadiness(params: {
  token: string;
  base: string;
  number: number;
  head: string;
  openedAt?: number;
  signal?: AbortSignal;
}): Promise<MergeReadiness> {
  if (
    params.openedAt !== undefined &&
    Date.now() - params.openedAt < CHECKS_SETTLE
  )
    return { state: "waiting", waitingFor: [] };
  const { token, base, signal } = params;
  const checkRuns = (page: number) =>
    githubJson<{
      total_count?: number;
      check_runs?: Array<{
        name?: string;
        status?: string;
        conclusion?: string | null;
      }>;
    }>({
      token,
      url: `${base}/commits/${params.head}/check-runs?filter=latest&per_page=100&page=${page}`,
      signal,
      errors: githubSyncErrors,
    });
  const [first, pull] = await Promise.all([
    checkRuns(1),
    githubJson<{
      mergeable_state?: string;
      draft?: boolean;
      base?: { ref?: string };
    }>({
      token,
      url: `${base}/pulls/${params.number}`,
      signal,
      errors: githubSyncErrors,
    }),
  ]);
  // A conflict or a draft waits for a person, not for a check: the merge
  // would be refused, and a conflict does not even start the workflows.
  if (pull.draft || pull.mergeable_state === "draft")
    return {
      state: "held",
      reason: "it is a draft, which someone marks ready for review on GitHub",
    };
  if (pull.mergeable_state === "dirty")
    return {
      state: "held",
      reason: `it conflicts with the ${pull.base?.ref ?? "base"} branch, which someone with write access resolves on GitHub`,
    };
  // Every page: a check that failed past the first one holds the merge too.
  const listed = [...(first.check_runs ?? [])];
  const total = first.total_count ?? listed.length;
  for (let page = 2; listed.length < total && page <= CHECK_RUN_PAGES; page++) {
    const next = (await checkRuns(page)).check_runs ?? [];
    if (next.length === 0) break;
    listed.push(...next);
  }
  // Runs GitHub counts but the App did not read could be failing ones.
  if (listed.length < total)
    return {
      state: "held",
      reason: `GitHub lists ${total} checks on it, more than the App reads before a merge, so someone with write access merges it on GitHub`,
    };
  const running = new Set<string>();
  const failed = new Set<string>();
  for (const run of listed) {
    const name = run.name || "a check";
    if (run.status !== "completed") running.add(name);
    else if (!PASSING.has(run.conclusion ?? "")) failed.add(name);
  }
  if (failed.size > 0) return { state: "failed", failed: [...failed] };
  if (running.size > 0) return { state: "waiting", waitingFor: [...running] };
  // Commit statuses take a permission the App does not ask for to read, so
  // GitHub's own merge state stands for them: "unstable" is a check or status
  // that does not pass, "unknown" one not worked out yet.
  if (pull.mergeable_state === "unstable")
    return { state: "waiting", waitingFor: ["a commit status"] };
  if (pull.mergeable_state === "unknown")
    return { state: "waiting", waitingFor: [] };
  return { state: "ready" };
}

/**
 * A refused merge of one self-served pull request at its head: when, how
 * often, and why, in the user's terms. GitHub makes a new test-merge commit
 * after every refused merge, so this is kept by number and head, apart from
 * the check result, which follows the test-merge commit.
 */
type MergeRefusal = {
  at: number;
  count: number;
  reason: string;
  /**
   * The branch ruleset takes the check from another GitHub App: nothing but
   * fixing the ruleset lets it merge, and that fix forgets the refusal.
   */
  ruleset?: boolean;
};

/** One repository's refused merges, by pull request number and head. */
function mergeRefusalsKey(organizationId: string, repo: string) {
  return checkKey("merge-refused", organizationId, repo);
}

function refusalSlot(pull: { number?: number; head: string }) {
  return `${pull.number ?? 0}:${pull.head}`;
}

/** The last refused merge of a pull request at its head, if any. */
export async function mergeRefusalOf(
  source: { organizationId: string; repo: string },
  pull: { number?: number; head: string },
): Promise<MergeRefusal | undefined> {
  const refusals = await cacheManager
    .get<Record<string, MergeRefusal>>(
      mergeRefusalsKey(source.organizationId, source.repo),
    )
    .catch(() => undefined);
  return refusals?.[refusalSlot(pull)];
}

async function recordMergeRefusal(
  source: { organizationId: string; repo: string },
  pull: { number?: number; head: string },
  refusal: Omit<MergeRefusal, "at">,
) {
  const key = mergeRefusalsKey(source.organizationId, source.repo);
  const refusals =
    (await cacheManager
      .get<Record<string, MergeRefusal>>(key)
      .catch(() => undefined)) ?? {};
  await cacheManager
    .set(
      key,
      { ...refusals, [refusalSlot(pull)]: { ...refusal, at: Date.now() } },
      CHECKED_TTL,
    )
    .catch((err) =>
      logger.warn(
        { organizationId: source.organizationId, err },
        "OpenAPPA could not record a refused merge",
      ),
    );
}

/**
 * Forget the refusals a ruleset caused: it requires the check from this App
 * now. True when there were any, so their pull requests are merged at once.
 */
async function forgetRulesetRefusals(
  organizationId: string,
  repo: string,
): Promise<boolean> {
  const key = mergeRefusalsKey(organizationId, repo);
  const refusals = await cacheManager
    .get<Record<string, MergeRefusal>>(key)
    .catch(() => undefined);
  if (!refusals) return false;
  const kept = Object.fromEntries(
    Object.entries(refusals).filter(([, refusal]) => !refusal.ruleset),
  );
  if (Object.keys(kept).length === Object.keys(refusals).length) return false;
  await cacheManager.set(key, kept, CHECKED_TTL).catch(() => undefined);
  return true;
}

/**
 * Check one organization's pull requests now, outside the minute's round:
 * one just opened, or a ruleset just fixed, need not wait for it. Failures
 * are logged; the minute's round checks them again.
 */
export function checkAppaPullRequestsSoon(organizationId: string) {
  return checkAppaGithubPullRequests(organizationId).catch((error) =>
    logger.warn(
      { organizationId, error },
      "OpenAPPA could not check the policy repository's pull requests",
    ),
  );
}

/**
 * Why GitHub refused a merge, in the user's terms. A ruleset that takes the
 * check from another App is named with its fix, since only that lets it
 * merge.
 */
function explainMergeRefusal(refused: { status: number; message?: string }): {
  reason: string;
  ruleset: boolean;
} {
  if (/not set by the expected GitHub App/i.test(refused.message ?? ""))
    return {
      ruleset: true,
      reason: `the branch ruleset takes the ${POLICY_CHECK_NAME} check from another GitHub App, so GitHub does not count the one this App posts. An administrator makes the ruleset take it from this App under Settings → Guardrails → Finish setup, and the App merges the pull request soon after`,
    };
  return { ruleset: false, reason: refusalReason(refused) };
}

/** Why GitHub refused a merge, in its words where it gave any. */
function refusalReason(refused: { status: number; message?: string }): string {
  return refused.message
    ? `GitHub answered ${refused.status}: ${refused.message}`
    : `GitHub answered ${refused.status}`;
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
  kind:
    | "checked"
    | "refused"
    | "merge"
    | "merge-refused"
    | "resync"
    | "protection"
    | "leftover"
    | "leftover-posted"
    | "leftover-read"
    | "self-service-seen"
    | "setup-posted",
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
    .set(params.key, { reason: params.reason }, REFUSED_TTL)
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
  /**
   * Passed; `skipped` when the pull request changes nothing Git sync reads,
   * or when self-service is off and a leftover rule still asks for the
   * check, which `title` and `reason` then say.
   */
  | { accepted: true; skipped?: true; title?: string; reason?: string }
  | { accepted: false; title?: string; reason: string };

type CheckedPull = {
  head: string;
  /** The pull request's number and head branch, where the host gives them. */
  number?: number;
  ref?: string;
  /** The commit checked: GitHub's merge result when it has one, else the head. */
  result: string;
  /** When it was opened, where the host says: its checks register after it. */
  openedAt?: number;
  post: (outcome: PullOutcome) => Promise<void>;
  /**
   * The files Git sync reads that the pull request changes, and, for one
   * Archestra opened, whether the person who asked may change them; null for
   * a read that failed for now. Absent where the host cannot tell, in which
   * case the policy is checked for every pull request.
   */
  judge?: () => Promise<Judged | null>;
};

/**
 * What a pull request changes that Git sync reads, whether it may, and
 * whether it is self-served: one this deployment's App opened on a server
 * rules branch, for a member it names.
 */
type Judged = { governed: string[]; outcome: PullOutcome; selfServed: boolean };

type PolicySource = RepositorySource & {
  path: string;
  ref: string | null;
  validationDirectory?: string | null;
  /** The pull request setup opened, while it waits for its merge. */
  setupPullRequestNumber?: number | null;
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
  if (outcome.accepted && outcome.title && outcome.reason)
    return { title: outcome.title, summary: outcome.reason };
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
      head?: { sha?: string; ref?: string };
      merge_commit_sha?: string | null;
      created_at?: string;
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
  return pulls.flatMap((pull): CheckedPull[] => {
    const head = pull.head?.sha;
    if (!head || !/^[a-f0-9]{40}$/.test(head)) return [];
    const merged = pull.merge_commit_sha;
    const number = pull.number;
    const ref = pull.head?.ref;
    return [
      {
        head,
        ...(number ? { number } : {}),
        ...(ref ? { ref } : {}),
        result: merged && /^[a-f0-9]{40}$/.test(merged) ? merged : head,
        ...(pull.created_at && !Number.isNaN(Date.parse(pull.created_at))
          ? { openedAt: Date.parse(pull.created_at) }
          : {}),
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
                  ref: ref ?? null,
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
  /** The head branch: only a server rules branch is self-served. */
  ref: string | null;
  user: GithubPullUser | null;
}): Promise<Judged | null> {
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
  // A pull request just opened can list no files for a moment, before GitHub
  // has its diff: one that says it changes files is checked next minute
  // rather than passed as changing nothing.
  if (changed.length === 0) {
    const opened = await githubCall<{ changed_files?: number }>({
      token,
      url: `${base}/pulls/${number}`,
    }).catch(() => null);
    if (!opened?.ok) return null;
    if ((opened.body.changed_files ?? 0) > 0) {
      logger.debug(
        { organizationId: source.organizationId, number },
        "A pull request lists no files yet; its check waits for the next minute",
      );
      return null;
    }
  }
  if (changed === "over")
    return {
      governed: [],
      selfServed: false,
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
    return { governed: paths, selfServed: false, outcome: { accepted: true } };
  const own = await ownIdentity({ source });
  if (own === null) return null;
  const byArchestra =
    own !== undefined &&
    own.login.toLowerCase() === params.user?.login?.toLowerCase();
  if (!byArchestra)
    return { governed: paths, selfServed: false, outcome: { accepted: true } };
  const requester = await archestraPullRequester({
    ...params,
    own,
    governed,
    // The setup pull request, and the include a pull proposed for
    // self-service: setup and the switch took the permission, not a person.
    setup:
      source.setupPullRequestNumber === number ||
      params.ref === SELF_SERVICE_INCLUDE_BRANCH,
  });
  if (requester === null) return null;
  if ("refused" in requester)
    return { governed: paths, selfServed: false, outcome: requester.refused };
  if ("setup" in requester)
    return { governed: paths, selfServed: false, outcome: { accepted: true } };
  const { userId, email } = requester;
  const prefixes = governed.some((file) => file.prefix !== null)
    ? await catalogToolPrefixes(source.organizationId)
    : null;
  let needsPolicyPermission = false;
  for (const file of governed) {
    if (
      !file.prefix ||
      !prefixes?.byPrefix.get(file.prefix)?.size ||
      governsBuiltInTools(file.prefix, prefixes)
    ) {
      // No server carries that prefix, or the built-in tools do: the policy's
      // own matter.
      needsPolicyPermission = true;
      continue;
    }
    // The file governs every server whose tools carry its prefix, so the
    // requester needs edit access to each one that owns it.
    const refused = await ownersNotEditable({
      organizationId: source.organizationId,
      userId,
      servers: await rulesFileServers(file.prefix, prefixes),
    });
    if (refused.length > 0)
      return {
        governed: paths,
        selfServed: false,
        outcome: {
          accepted: false,
          title: "The requester may not change these rules",
          reason: `${email} may not change ${file.path}: that takes edit access to ${await ownersAsNamedFor(
            {
              organizationId: source.organizationId,
              userId,
              servers: refused,
            },
          )} in the MCP registry.`,
        },
      };
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
          !prefixes?.byPrefix.get(file.prefix)?.size ||
          governsBuiltInTools(file.prefix, prefixes),
      );
      return {
        governed: paths,
        selfServed: false,
        outcome: {
          accepted: false,
          title: "The requester may not change the policy",
          reason: `${email} may not change ${first?.path ?? source.path}: that takes the guardrailsPolicy:update permission.`,
        },
      };
    }
  }
  return {
    governed: paths,
    // Opened by the App for a member who may make the change: auto-merge
    // takes it only on a server rules branch, never on any other proposal.
    selfServed: isServerRulesBranch(params.ref ?? ""),
    outcome: { accepted: true },
  };
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
  // Sync reads the `.appa` files directly in the validations folder and
  // nothing else there: a README beside them is not the policy's.
  const validation = (path: string) =>
    path.startsWith(`${validations}/`) &&
    path.endsWith(".appa") &&
    !path.slice(validations.length + 1).includes("/");
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
      validation(path)
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
  /** The source's own setup pull request. */
  setup: boolean;
}): Promise<
  | { userId: string; email: string }
  | { refused: PullOutcome }
  | { setup: true }
  | null
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
  // A setup pull request opened before setup named who asked for it: setup
  // itself took the permission to set the policy. So did turning
  // self-service on, for the include a pull proposes with no requester.
  if (params.setup && emails.size === 1 && !email) return { setup: true };
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
  // Saved with auto-merge in force, the App may just have been granted what
  // it lacked: the next minute's round tries the merge rather than waiting
  // out a hold. A save that failed above lifts nothing.
  if (
    params.source.githubAppConfigId &&
    config.openappa.selfService === "enabled" &&
    autoMergeState().enabled
  )
    await cacheManager
      .delete(heldMergesKey(params.organizationId, params.source.repo))
      .catch((err) =>
        logger.warn(
          { organizationId: params.organizationId, err },
          "OpenAPPA could not forget a held merge",
        ),
      );
}

/** A rejected or timed-out network call, as `fetch` and `AbortSignal.timeout` raise them. */
function isTransportError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (["TimeoutError", "AbortError"].includes(error.name) ||
      (error instanceof TypeError &&
        /fetch failed|failed to fetch|network/i.test(error.message)) ||
      /ECONN|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(error.message))
  );
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
      repository.full_name?.toLowerCase() !== params.repo.toLowerCase()
    )
      throw params.error;
    // A copy GitHub made from the template, or any private repository that
    // holds the template's example unchanged: both are fresh copies to seed.
    const existing = await githubJson<{ sha?: string }>({
      url: `${params.api}/repos/${params.repo}/contents/appa.toml`,
      token: params.token,
      errors: githubSyncErrors,
    });
    if (!existing.sha) throw params.error;
    if (existing.sha === templateExampleBlob()) return repository;
    if (
      repository.template_repository?.full_name?.toLowerCase() !==
      TEMPLATE_REPO.toLowerCase()
    )
      throw params.error;
    const template = await githubJson<{ sha?: string }>({
      url: `${params.api}/repos/${TEMPLATE_REPO}/contents/appa.toml`,
      token: params.token,
      errors: githubSyncErrors,
    });
    if (existing.sha !== template.sha) throw params.error;
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
}): Promise<{
  branch: string;
  setupPullRequestNumber?: number;
  setupCommit?: string;
}> {
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
  const { setupPullRequestNumber, setupCommit } = await commitSetupFiles({
    base,
    token,
    branch,
    parent,
    files: [...rest, ...params.transferred],
    message,
    pull: {
      title: message,
      body: setupPullBody(params.transferred, false, "github"),
    },
    direct: true,
  });
  return { branch, setupPullRequestNumber, setupCommit };
}

/** A file setup writes into the policy repository, by its path there. */
type SetupFile = { path: string; content: string };

const SETUP_TITLE = "Seed current OpenAPPA policy";

/**
 * The setup commit's message names who set the sync up, in the trailer the
 * policy check reads a requester from, so the setup pull request gets the
 * check like any other Archestra opens.
 */
async function setupMessage(userId: string): Promise<string> {
  const requester = await UserModel.getById(userId);
  return requester ? withRequester(SETUP_TITLE, requester.email) : SETUP_TITLE;
}

/** One file's text at a commit, or null when the commit has no such file. */
async function githubFileAt(params: {
  base: string;
  token: string;
  commit: string;
  path: string;
}): Promise<string | null> {
  const response = await githubFetch({
    url: `${params.base}/contents/${params.path.split("/").map(encodeURIComponent).join("/")}?ref=${params.commit}`,
    token: params.token,
    accept: "application/vnd.github.raw+json",
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new ApiError(
      502,
      `GitHub returned HTTP ${response.status} for ${params.path}. Check repository access.`,
    );
  const bytes = await readResponseBodyWithLimit(response, 256 * 1024);
  return bytes ? bytes.toString("utf8") : "";
}

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
  /** The policy text setup writes, whose include list decides what comes along. */
  seed: string;
  /** The current policy, whose own includes must be readable; an entry only the seed adds has no files to carry yet. */
  current: string;
}): Promise<SetupTransfer> {
  const { organizationId } = params;
  const entries = repositoryIncludePaths(params.seed);
  const required = new Set(repositoryIncludePaths(params.current));
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
  const missing = entries.find((entry) => required.has(entry));
  if (!accepted && missing !== undefined)
    throw new ApiError(
      409,
      `The current policy includes ${missing} from its repository, and Git sync has accepted no commit to copy it from. Connect the repository that holds it, or remove the include, before setting up another repository.`,
    );
  if (entries.length > 0 && accepted) {
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
  host: "github" | "gitlab",
): string {
  const request = host === "gitlab" ? "merge request" : "pull request";
  const hostName = host === "gitlab" ? "GitLab" : "GitHub";
  const carried = Array.isArray(transfer)
    ? transfer.length
    : transfer.includes.size + transfer.validations.length;
  const files =
    carried === 0
      ? ""
      : ` It also carries ${carried === 1 ? "the file" : `the ${carried} files`} the policy reads beside itself.`;
  return existing
    ? `This ${request} puts your current OpenAPPA policy in place of the one in this repository.${files} Merge it as it is, or change this branch first to combine the two. Your current policy stays active until this ${request} is merged.`
    : `Review and merge this ${request} to finish ${hostName} policy sync setup.${files} Your current policy stays active until this ${request} is merged.`;
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

/** An entry of the repository's tree: a file, a link or a folder, with its mode. */
type TreeEntry = { path: string; type: string; mode?: string; sha?: string };

/** Everything the repository holds at `commit`, with each entry's mode. */
async function treeEntries(params: {
  base: string;
  token: string;
  commit: string;
}): Promise<TreeEntry[]> {
  const tree = await githubJson<{
    truncated?: boolean;
    tree?: Array<{ path?: string; type?: string; mode?: string }>;
  }>({
    url: `${params.base}/git/trees/${params.commit}?recursive=1`,
    token: params.token,
    errors: githubSyncErrors,
  });
  if (tree.truncated)
    throw new ApiError(
      400,
      "The repository holds too many files to read in one pass",
    );
  return (tree.tree ?? []).flatMap((entry) =>
    entry.path && entry.type
      ? [{ path: entry.path, type: entry.type, mode: entry.mode }]
      : [],
  );
}

/**
 * What setup removes from a repository whose policy includes globs: the
 * files those globs would read that it does not write. A path among the
 * written or removed ones that is not a regular file, a symbolic link or a
 * folder, is refused, as any proposal refuses it.
 */
async function strayFilesToRemove(params: {
  base: string;
  token: string;
  commit: string;
  content: string;
  policyPath: string;
  files: SetupFile[];
}): Promise<string[]> {
  if (!hasRepositoryIncludeGlob(params.content)) return [];
  const entries = await treeEntries(params);
  const remove = strayGlobMatches({
    content: params.content,
    policyPath: params.policyPath,
    paths: entries
      .filter((entry) => entry.type === "blob")
      .map((entry) => entry.path),
    written: params.files.map((file) => file.path),
  });
  return remove;
}

/**
 * Refuse a setup write or removal at a path that is not a regular file, or
 * under a folder that is not a folder: a symbolic link or a submodule there
 * is left alone, as any proposal leaves it. Only the trees along the paths
 * are read, so a large repository costs a few small reads, and a path that
 * does not exist yet is fine: setup creates it.
 */
async function assertRegularSetupPaths(params: {
  base: string;
  token: string;
  commit: string;
  paths: string[];
}): Promise<void> {
  const trees = new Map<string, TreeEntry[]>();
  const read = async (sha: string) => {
    const cached = trees.get(sha);
    if (cached) return cached;
    const tree = await githubJson<{
      truncated?: boolean;
      tree?: Array<{
        path?: string;
        type?: string;
        mode?: string;
        sha?: string;
      }>;
    }>({
      url: `${params.base}/git/trees/${sha}`,
      token: params.token,
      errors: githubSyncErrors,
    });
    const entries = (tree.tree ?? []).flatMap((entry) =>
      entry.path && entry.type
        ? [
            {
              path: entry.path,
              type: entry.type,
              mode: entry.mode,
              sha: entry.sha,
            },
          ]
        : [],
    );
    trees.set(sha, entries);
    return entries;
  };
  for (const path of new Set(params.paths)) {
    const segments = path.split("/");
    let sha = params.commit;
    for (const [index, segment] of segments.entries()) {
      const entry = (await read(sha)).find((item) => item.path === segment);
      if (!entry) break;
      const last = index === segments.length - 1;
      const regular = last
        ? entry.type === "blob" &&
          (entry.mode === undefined || REGULAR_FILE_MODES.has(entry.mode))
        : entry.type === "tree";
      if (!regular)
        throw new ApiError(
          400,
          `${path} is not a regular file in the repository`,
        );
      if (last || !entry.sha) break;
      sha = entry.sha;
    }
  }
}

const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

/** The stray files to remove, once every written and removed path is checked. */
async function regularStrayFilesToRemove(params: {
  base: string;
  token: string;
  commit: string;
  content: string;
  policyPath: string;
  files: SetupFile[];
}): Promise<string[]> {
  const remove = await strayFilesToRemove(params);
  await assertRegularSetupPaths({
    base: params.base,
    token: params.token,
    commit: params.commit,
    paths: [...params.files.map((file) => file.path), ...remove],
  });
  return remove;
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
  /** Paths the commit removes. */
  remove?: string[];
  message: string;
  pull: { title: string; body: string };
  direct: boolean;
}): Promise<{ setupPullRequestNumber?: number; setupCommit?: string }> {
  const { base, token, branch, parent } = params;
  const files = firstFileAtEachPath(params.files);
  const removed = (params.remove ?? []).map((path) => ({
    path,
    mode: "100644",
    type: "blob",
    sha: null,
  }));
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
        tree: [
          ...entries.map((file) => ({
            path: file.path,
            mode: "100644",
            type: "blob",
            content: file.content,
          })),
          ...removed,
        ],
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
      errors: withGithubMessage((status, message) => {
        if (/workflow/i.test(message ?? "")) workflowRefused = true;
        return new ApiError(
          status === 422 ? 409 : 502,
          `GitHub returned HTTP ${status}. Check repository access and App permissions.`,
        );
      }),
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
    return { setupPullRequestNumber: pull.number, setupCommit: sha };
  };
  let commit = await commitFiles(files);
  if (!commit) return {};
  // A workflow file takes the App's Workflows permission; without it the
  // proposal goes out with everything else, as a direct write does.
  let workflowRefused = false;
  if (!params.direct)
    try {
      return await propose(commit.sha);
    } catch (error) {
      if (
        !workflowRefused ||
        !files.some((file) => file.path.startsWith(".github/workflows/"))
      )
        throw error;
      commit = await commitFiles(
        files.filter((file) => !file.path.startsWith(".github/workflows/")),
      );
      if (!commit) return {};
      return propose(commit.sha);
    }
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
        // Only workflow files need that permission; a validation folder
        // under .github stays.
        commit = await commitFiles(
          files.filter((file) => !file.path.startsWith(".github/workflows/")),
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
 * Why a server has no rules file, or `null` when it has one. The file is
 * named by the server's own slug, which must be a safe file name, and every
 * one of its tools carries that prefix, so no server reaches another's file,
 * or the built-in tools, through its name. Other servers whose tools carry
 * the same prefix share the file.
 */
export function rulesFileRefusal(params: {
  catalog: { id: string; name: string };
  /** The server's own tool names. */
  tools: readonly string[];
  prefixes: ToolPrefixes;
}): string | null {
  const { catalog, tools, prefixes } = params;
  const prefix = slugifyMcpServerName(catalog.name);
  if (!SAFE_PREFIX.test(prefix) || prefix.includes("__"))
    return `${catalog.name} has no rules file: its tool prefix, ${prefix}, is not a safe file name or holds "__".`;
  const stray = [
    ...new Set(
      tools.flatMap((tool) => {
        const { serverName } = parseFullToolName(tool);
        if (serverName === prefix) return [];
        return [
          serverName === null ? `${tool} (no prefix)` : `${serverName}__`,
        ];
      }),
    ),
  ].sort();
  if (stray.length > 0)
    return `${catalog.name} has no rules file: some of its tools carry other prefixes than ${prefix}__ (${stray.join(", ")}).`;
  if (governsBuiltInTools(prefix, prefixes))
    return `${catalog.name} has no rules file: its tools carry the prefix ${prefix}__ of the built-in ${archestraMcpBranding.catalogName} tools, which only the organization's own policy governs.`;
  if (
    [...(prefixes.byPrefix.get(prefix) ?? [])].some(
      (id) => id !== catalog.id && prefixes.conflicting.has(id),
    )
  )
    return `${catalog.name} has no rules file: another MCP server's tools put "__" inside its tool prefix, ${prefix}__.`;
  return null;
}

/**
 * Whether a prefix is the built-in tools' own: their catalog carries it, or it
 * is one of their names (a white-labeled deployment's, and the default name
 * they still answer to). A catalog that predates the name check can still
 * carry it, and a rules file for it would govern the built-in tools too.
 */
function governsBuiltInTools(prefix: string, prefixes: ToolPrefixes): boolean {
  return (
    archestraMcpBranding.allowedServerNames.includes(prefix) ||
    [...(prefixes.byPrefix.get(prefix) ?? [])].some(isBuiltInCatalogId)
  );
}

/** A server a rules file governs, and whether its editors gate the file. */
type RulesFileServer = {
  id: string;
  name: string;
  scope: "personal" | "team" | "org";
  owner: boolean;
};

/**
 * Every server a rules file governs: each catalog whose tools carry its
 * prefix, since rules are keyed by tool name. The shared entries (scope
 * `org` or `team`) own the file; members' personal copies follow it and
 * gate nothing, unless no shared entry carries the prefix.
 */
export async function rulesFileServers(
  prefix: string,
  prefixes: ToolPrefixes,
): Promise<RulesFileServer[]> {
  const catalogs = await InternalMcpCatalogModel.getByIds([
    ...(prefixes.byPrefix.get(prefix) ?? []),
  ]);
  const shared = [...catalogs.values()].some(
    (catalog) => catalog.scope !== "personal",
  );
  return [...catalogs.values()]
    .map((catalog) => ({
      id: catalog.id,
      name: catalog.name,
      scope: catalog.scope,
      owner: !shared || catalog.scope !== "personal",
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** Names as a sentence lists them: "a", "a and b", "a, b and c". */
export function listedNames(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Owners as a check summary or pull request body names them: by name when
 * the member may open them in the MCP registry, counted otherwise, since
 * everyone who reads the repository reads both.
 */
export async function ownersAsNamedFor(params: {
  organizationId: string;
  userId: string;
  servers: readonly RulesFileServer[];
}): Promise<string> {
  const permissions = ResourcePermissions;
  const readable = await Promise.all(
    params.servers.map((server) =>
      permissions.allows({
        organizationId: params.organizationId,
        userId: params.userId,
        resource: "mcpRegistry",
        scope: server.id,
        action: "read",
      }),
    ),
  );
  const named = params.servers
    .filter((_, index) => readable[index])
    .map((server) => server.name);
  const unseen = params.servers.length - named.length;
  const hidden =
    unseen === 0
      ? []
      : [
          unseen === 1
            ? "an MCP server they cannot see"
            : `${unseen} MCP servers they cannot see`,
        ];
  if (named.length === 0) return listedNames(hidden);
  const items = [...named, ...hidden];
  return `the MCP server${items.length > 1 ? "s" : ""} ${listedNames(items)}`;
}

/** The owners of a rules file a member may not edit in the MCP registry. */
export async function ownersNotEditable(params: {
  organizationId: string;
  userId: string;
  servers: readonly RulesFileServer[];
}): Promise<RulesFileServer[]> {
  const permissions = ResourcePermissions;
  const owners = params.servers.filter((server) => server.owner);
  const allowed = await Promise.all(
    owners.map((server) =>
      permissions.allows({
        organizationId: params.organizationId,
        userId: params.userId,
        resource: "mcpRegistry",
        scope: server.id,
        action: "update",
      }),
    ),
  );
  return owners.filter((_, index) => !allowed[index]);
}

// =============================================================================
// Repository protection: who reviews each server's file, and the branch rules
// =============================================================================

/** The permissions the GitHub App needs, each tried as its own job token. */
const GITHUB_APP_PERMISSIONS = [
  "contents",
  "pull_requests",
  "checks",
  "workflows",
] as const;

/** What posting the policy check takes, of those. */
const CHECK_PERMISSIONS = ["contents", "pull_requests", "checks"] as const;

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
  /**
   * Whether a rule on the synced branch requires the policy check, as GitHub
   * evaluates the branch. Archestra writes no rule: `missing` and
   * `incomplete` carry the ruleset an administrator imports, and the page to
   * import it on.
   */
  branchRules: {
    state:
      | "active"
      | "incomplete"
      | "missing"
      | "needs_permission"
      | "unavailable"
      | "error";
    /** The ruleset that requires the check, on its host. */
    url?: string;
    detail?: string;
    /**
     * A rule requires the check while the App cannot post it, so pull
     * requests wait on it. Absent while the check is posted.
     */
    checkRule?: "unposted";
    /** The repository's Rulesets page, where a ruleset is imported or edited. */
    settingsUrl?: string;
    /** The ruleset to import, while no rule requires the check as it should. */
    ruleset?: ImportRuleset;
  };
};

/**
 * The policy repository's protection while self-service is on: whether a
 * branch rule requires the policy check, which is where who may change each
 * file is decided, and what the GitHub App may do. Null while self-service
 * is off, or without a connected GitHub App source. The rules are read with
 * Metadata, which every App has; Archestra never writes them.
 */
async function repositoryProtection(
  organizationId: string,
): Promise<RepositoryProtection | null> {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!selfServiceActive(row)) return null;
  // The branch's rules and the App's grants are there to read as soon as
  // the repository is connected, a setup pull request still open or not:
  // the administrator imports the ruleset while it waits.
  const source = {
    ...row,
    repo: row.repo,
    path: row.path,
    sourceCommit: row.sourceCommit ?? "",
  };
  const checkName = POLICY_CHECK_NAME;
  const [branchRules, app] = await Promise.all([
    githubBranchRules(source, checkName).catch((error) => ({
      state: "error" as const,
      detail: protectionError(error),
    })),
    githubAppReadiness(source).catch((error) => {
      logger.warn(
        { organizationId, error },
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
  // should not wait out a refused round of checks, whatever else, such as
  // Workflows, the App still lacks.
  if (
    grants &&
    CHECK_PERMISSIONS.every((name) =>
      grants.permissions.some(
        (permission) => permission.name === name && permission.granted,
      ),
    )
  )
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
 * once a minute, and replaced by what each sync reads.
 */
export async function getRepositoryProtection(
  organizationId: string,
  options: {
    /** Read GitHub now: the administrator just imported or edited the ruleset. */
    fresh?: boolean;
  } = {},
): Promise<RepositoryProtection | null> {
  const cached = options.fresh
    ? undefined
    : await cachedProtection(organizationId);
  if (cached !== undefined) return cached;
  const read = await repositoryProtection(organizationId);
  await rememberProtection(organizationId, read);
  await mergeWhatTheRulesetHeld(organizationId, read);
  return read;
}

/**
 * The protection for a round of merges: the minute's cached read, or GitHub
 * once it has expired. The round merges what a fixed ruleset held itself.
 */
async function protectionRead(organizationId: string) {
  const cached = await cachedProtection(organizationId);
  if (cached !== undefined) return cached;
  const read = await repositoryProtection(organizationId);
  await rememberProtection(organizationId, read);
  return read;
}

/**
 * A ruleset that requires the check from this App now: the pull requests
 * GitHub refused to merge for it are merged at once, not fifteen minutes on.
 */
async function mergeWhatTheRulesetHeld(
  organizationId: string,
  read: RepositoryProtection | null,
) {
  if (read?.branchRules.state !== "active") return;
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (row?.repo && (await forgetRulesetRefusals(organizationId, row.repo)))
    void checkAppaPullRequestsSoon(organizationId);
}

/**
 * Read the repository's protection, as each sync does. On, the branch rules
 * are read and shown. Off, a rule that still requires the check is recorded:
 * Archestra cannot take it off, so it keeps posting the check, and the
 * settings name the rule to remove before a move or a stop.
 */
async function maintainRepositoryProtection(
  organizationId: string,
  options: {
    /** Self-service was just turned off: read the rules whatever was seen. */
    turnedOff?: boolean;
  } = {},
): Promise<RepositoryProtection | null> {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (selfServiceActive(row)) {
    const read = await repositoryProtection(organizationId);
    await rememberProtection(organizationId, read);
    await mergeWhatTheRulesetHeld(organizationId, read);
    await forgetLeftoverRule(organizationId, row.repo);
    await cacheManager
      .set(selfServiceSeenKey(organizationId, row.repo), true, LEFTOVER_TTL)
      .catch(() => undefined);
    return read;
  }
  await rememberProtection(organizationId, null);
  if (row?.interval && row.repo && row.path && row.githubAppConfigId) {
    // Only a repository self-service was on for lately can have a rule left
    // behind; the rest is not read for one.
    const source = { ...row, repo: row.repo };
    if (options.turnedOff || (await mayHaveLeftoverRule(source)))
      await recordLeftoverRule(source);
  }
  return null;
}

/**
 * Before a source is saved or stopped: a rule on the branch the sync leaves
 * that requires the check would hold every pull request there once nothing
 * posts it, and Archestra cannot take a rule off. The change waits until the
 * administrator removes the rule; a branch that cannot be read is theirs to
 * look after.
 */
async function beforeSourceChange(
  organizationId: string,
  next: {
    repo: string;
    ref?: string | null;
    githubAppConfigId?: string | null;
  } | null,
) {
  const current = await OpenAppaGithubSyncModel.find(organizationId);
  // Another repository or branch, or none: its files are compared anew.
  if (
    !next ||
    current?.repo !== next.repo ||
    (current.ref ?? null) !== (next.ref ?? null)
  )
    await forgetTemplateFilesState(organizationId);
  if (
    !current?.interval ||
    !current.repo ||
    !current.path ||
    !current.githubAppConfigId
  )
    return;
  const source = { ...current, repo: current.repo };
  // Off, only a repository self-service was on for lately can have a rule
  // left behind, recorded or not yet read for; it is read again below, so
  // one removed on GitHub meanwhile holds nothing.
  if (!selfServiceActive(current) && !(await mayHaveLeftoverRule(source)))
    return;
  const leaves =
    !next ||
    current.repo !== next.repo ||
    (current.ref ?? null) !== (next.ref ?? null) ||
    // A token or a GitLab project in the App's place posts no check either.
    !next.githubAppConfigId;
  if (!leaves) return;
  let read: Awaited<ReturnType<typeof readPolicyCheckRule>>;
  try {
    read = await readPolicyCheckRule(source, POLICY_CHECK_NAME);
  } catch {
    return;
  }
  if (!read.ok || !read.found) return;
  throw new ApiError(
    409,
    `A branch rule on ${current.repo} still requires the ${POLICY_CHECK_NAME} check${read.url ? ` (${read.url})` : ""}. Remove it first: once ${archestraMcpBranding.appName} stops posting the check there, every pull request would wait on it.`,
  );
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

/**
 * The ruleset an administrator imports, in the shape GitHub's "Import a
 * ruleset" takes and its export gives.
 */
type ImportRuleset = {
  name: string;
  target: "branch";
  source_type: "Repository";
  source: string;
  enforcement: "active";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  bypass_actors: unknown[];
  rules: Rule[];
};

/** One active rule on a branch, as GitHub lists them, with the ruleset it comes from. */
type BranchRule = Rule & {
  ruleset_id?: number;
  ruleset_source_type?: string;
  ruleset_source?: string;
};

type RequiredCheck = { context?: string; integration_id?: number };

/** A source whose branch rules are read: the sync row, connected or not. */
type RuledSource = {
  organizationId: string;
  repo: string;
  ref: string | null;
  githubAppConfigId: string | null;
  githubPatId: string | null;
};

/**
 * Whether a rule on the synced branch requires the policy check, read as
 * GitHub evaluates the branch: every active ruleset counts, the repository's
 * and the organization's alike, and the read takes Metadata, which every App
 * has. Writing a ruleset takes Administration over the whole repository, so
 * Archestra never does: an administrator imports the one returned here on
 * the repository's Rulesets page, and the next read finds it.
 */
async function readPolicyCheckRule(
  source: RuledSource,
  checkName: string,
): Promise<
  | {
      ok: true;
      /** The rule that requires the check from this App, else one that names it. */
      found: { rule: BranchRule; entry: RequiredCheck } | null;
      url?: string;
      integrationId?: number;
      settingsUrl: string;
      ruleset: ImportRuleset;
    }
  | {
      ok: false;
      state: "needs_permission" | "unavailable" | "error";
      detail: string;
      settingsUrl?: string;
      ruleset?: ImportRuleset;
    }
> {
  const { token, api, web } = await resolveOpenAppaGithubAccess(source, {
    metadata: "read",
  });
  if (!token)
    return {
      ok: false,
      state: "needs_permission",
      detail:
        "The policy repository is read without a credential. Connect it through a GitHub App, which posts the check.",
    };
  const base = `${api}/repos/${source.repo}`;
  const branch = source.ref ?? (await defaultBranch({ token, base }));
  const integrationId = await checkIntegrationId(source);
  const settingsUrl = `${web}/${source.repo}/settings/rules`;
  const ruleset = desiredRuleset({
    repo: source.repo,
    branch,
    integrationId,
    checkName,
  });
  const rules = await githubCall<BranchRule[]>({
    token,
    url: `${base}/rules/branches/${encodeURIComponent(branch)}?per_page=100`,
  });
  if (!rules.ok)
    return { ok: false, ...unavailable(rules), settingsUrl, ruleset };
  const matches = (Array.isArray(rules.body) ? rules.body : []).flatMap(
    (rule) =>
      rule.type !== "required_status_checks"
        ? []
        : ((rule.parameters?.required_status_checks ?? []) as RequiredCheck[])
            .filter((entry) => entry.context === checkName)
            .map((entry) => ({ rule, entry })),
  );
  const found =
    matches.find(
      (match) =>
        integrationId !== undefined &&
        match.entry.integration_id === integrationId,
    ) ??
    matches[0] ??
    null;
  const url = found
    ? rulesetPage({ web, repo: source.repo, rule: found.rule })
    : undefined;
  return {
    ok: true,
    found,
    ...(url ? { url } : {}),
    ...(integrationId !== undefined ? { integrationId } : {}),
    settingsUrl,
    ruleset,
  };
}

/** The ruleset's page on its host: the repository's, or the organization's. */
function rulesetPage(params: {
  web: string;
  repo: string;
  rule: BranchRule;
}): string | undefined {
  const { rule } = params;
  if (typeof rule.ruleset_id !== "number") return undefined;
  return rule.ruleset_source_type === "Organization" && rule.ruleset_source
    ? `${params.web}/organizations/${rule.ruleset_source}/settings/rules/${rule.ruleset_id}`
    : `${params.web}/${params.repo}/rules/${rule.ruleset_id}`;
}

/**
 * The protection as the settings show it: whether a rule requires the check
 * from this App, and whether the App may post it. A required check nobody
 * posts holds every pull request, so without the Checks permission the
 * import waits, and a rule already there is reported as holding them.
 */
async function githubBranchRules(
  source: RuledSource,
  checkName: string,
): Promise<RepositoryProtection["branchRules"]> {
  const read = await readPolicyCheckRule(source, checkName);
  if (!read.ok)
    return {
      state: read.state,
      detail: read.detail,
      ...(read.settingsUrl ? { settingsUrl: read.settingsUrl } : {}),
      ...(read.ruleset ? { ruleset: read.ruleset } : {}),
    };
  const { found, url, integrationId, settingsUrl, ruleset } = read;
  const check = await policyCheckAccess(source, checkName);
  if (!found) {
    if (!check.postable)
      return {
        state: "needs_permission",
        detail: check.detail,
        settingsUrl,
        ruleset,
      };
    return { state: "missing", settingsUrl, ruleset };
  }
  // With the App's own id unknown, the rule offered takes the check from
  // any source, and one that does is what was asked for.
  const from = found.entry.integration_id;
  if (integrationId !== undefined && from !== integrationId)
    return {
      state: "incomplete",
      ...(url ? { url } : {}),
      settingsUrl,
      ruleset,
      detail:
        from === undefined
          ? `The rule takes the ${checkName} check from any source, so a passing one could be posted with any token. Edit it to take the check from the GitHub App only.`
          : `The rule takes the ${checkName} check from another app, so the one this GitHub App posts does not count. Edit it to take the check from this App.`,
    };
  if (!check.postable)
    return {
      state: "active",
      ...(url ? { url } : {}),
      checkRule: "unposted",
      detail: check.detail,
    };
  return { state: "active", ...(url ? { url } : {}) };
}

/**
 * Whether the source's credential may post the policy check: a token posts
 * a commit status; a GitHub App needs Checks and Pull requests, and one not
 * granted them says so.
 */
async function policyCheckAccess(
  source: RuledSource,
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
 * The ruleset an administrator imports on the policy repository's Rulesets
 * page (New ruleset → Import a ruleset): one rule, the policy check required
 * from this App, so a pull request that would break the policy, or change a
 * server's rules without its editor asking, cannot merge. Only this App's
 * check counts: no one posts a passing one with a token of their own. The
 * check posts on every pull request and is skipped when no policy file
 * changed, so the rule holds nobody up. Nothing else about the branch is
 * Archestra's, and the rule stays the repository's: whoever administers it
 * adds, edits or removes it.
 */
function desiredRuleset(params: {
  repo: string;
  branch: string;
  integrationId?: number;
  checkName: string;
}): ImportRuleset {
  return {
    name: params.checkName,
    target: "branch",
    source_type: "Repository",
    source: params.repo,
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

// === A rule left behind with self-service off ===

/** Off, a branch rule that still requires the check: shown, and it holds a move or a stop. */
type LeftoverRule = { checkName: string; url: string | null };

/** How long a leftover rule stands recorded between syncs. */
const LEFTOVER_TTL = 2 * TimeInMs.Day;

function leftoverRuleKey(organizationId: string, repo: string) {
  return checkKey("leftover", organizationId, repo);
}

/** Self-service was on for the repository lately: a rule may be left behind. */
function selfServiceSeenKey(organizationId: string, repo: string) {
  return checkKey("self-service-seen", organizationId, repo);
}

async function recordedLeftoverRule(
  source: Pick<RuledSource, "organizationId" | "repo">,
): Promise<LeftoverRule | undefined> {
  return cacheManager
    .get<LeftoverRule>(leftoverRuleKey(source.organizationId, source.repo))
    .catch(() => undefined);
}

/**
 * Self-service off: whether a branch rule still requires the check. Archestra
 * cannot take the rule off (that takes Administration, which it never
 * holds), so the record tells the administrator which rule to remove
 * before a move or a stop. Read at each sync; a read that fails keeps the
 * last record.
 */
/**
 * Whether the repository may have a rule left behind: one recorded, or
 * self-service on for it lately, with the record still to be read for. The
 * rest is not read for one.
 */
async function mayHaveLeftoverRule(
  source: Pick<RuledSource, "organizationId" | "repo">,
): Promise<boolean> {
  return (
    !!(await recordedLeftoverRule(source)) ||
    !!(await cacheManager
      .get(selfServiceSeenKey(source.organizationId, source.repo))
      .catch(() => undefined))
  );
}

/**
 * Self-service off, on a repository it was on for lately: the rule it may
 * have left behind is recorded now. Nothing found forgets the repository.
 */
async function recordLeftoverRuleSoon(row: SyncRow) {
  if (!row.repo || !row.path || !row.githubAppConfigId) return;
  const source = { ...row, repo: row.repo, path: row.path };
  if (await recordedLeftoverRule(source)) return;
  if (await mayHaveLeftoverRule(source)) await recordLeftoverRule(source);
}

async function recordLeftoverRule(source: RuledSource) {
  const checkName = POLICY_CHECK_NAME;
  const key = leftoverRuleKey(source.organizationId, source.repo);
  let read: Awaited<ReturnType<typeof readPolicyCheckRule>>;
  try {
    read = await readPolicyCheckRule(source, checkName);
  } catch (error) {
    logger.debug(
      { organizationId: source.organizationId, error },
      "OpenAPPA could not read the policy repository's branch rules",
    );
    return;
  }
  if (!read.ok) return;
  if (read.found) {
    const leftover: LeftoverRule = { checkName, url: read.url ?? null };
    await cacheManager.set(key, leftover, LEFTOVER_TTL);
    // Just read: the settings need no second look for a minute.
    await cacheManager
      .set(
        checkKey("leftover-read", source.organizationId, source.repo),
        true,
        TimeInMs.Minute,
      )
      .catch(() => undefined);
  } else {
    // Nothing left behind: the repository needs no read until self-service
    // is on again.
    await cacheManager.delete(key);
    await cacheManager.delete(
      selfServiceSeenKey(source.organizationId, source.repo),
    );
  }
}

async function forgetLeftoverRule(organizationId: string, repo: string) {
  await cacheManager
    .delete(leftoverRuleKey(organizationId, repo))
    .catch((err) =>
      logger.warn(
        { organizationId, err },
        "OpenAPPA could not forget a leftover branch rule",
      ),
    );
}

/** The leftover rule recorded for a source with self-service off, for the settings. */
async function leftoverRule(
  row: SyncRow,
): Promise<{ leftoverRule?: LeftoverRule }> {
  if (selfServiceActive(row) || !row.repo || !row.githubAppConfigId) return {};
  const source = { ...row, repo: row.repo };
  const found = await recordedLeftoverRule(source);
  if (!found) return {};
  // Read again, at most once a minute: a rule removed on GitHub leaves the
  // settings without waiting for the next sync.
  const read = checkKey("leftover-read", row.organizationId, row.repo);
  if (await cacheManager.get(read).catch(() => true))
    return { leftoverRule: found };
  await cacheManager.set(read, true, TimeInMs.Minute).catch(() => undefined);
  await recordLeftoverRule(source);
  const again = await recordedLeftoverRule(source);
  return again ? { leftoverRule: again } : {};
}

/** The App whose check the ruleset requires, or none for a token. */
export async function checkIntegrationId(source: {
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
function unavailable(response: { status: number; message?: string }): {
  state: "unavailable" | "error";
  detail: string;
} {
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
