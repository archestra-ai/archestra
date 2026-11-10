import { createHash, randomUUID } from "node:crypto";
import {
  getGithubWebOrigin,
  gitHostFromUrl,
  slugifyMcpServerName,
  TimeInMs,
} from "@archestra/shared";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { userHasPermission } from "@/auth";
import {
  type AllowedCacheKey,
  CacheKey,
  cacheManager,
  LRUCacheManager,
} from "@/cache-manager";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import { gitClient } from "@/git-hosts/git-access";
import { GitHostError } from "@/git-hosts/git-host-client";
import logger from "@/logging";
import { RuntimeCredentialDefinitionModel } from "@/models";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import MemberModel from "@/models/member";
import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import OpenAppaCredentialBindingModel from "@/models/openappa-credential-binding";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { port } from "@/models/ports";
import RoleCompositionModel from "@/models/role-composition";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
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
  isServerRulesFile,
  repositoryIncludePaths,
  serverRulesPrefix,
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
    hasPolicy: content !== null,
    validationDirectory,
    githubWebUrl,
    provider,
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
  if (Buffer.byteLength(policy.content) > 1024 * 1024)
    throw new ApiError(
      400,
      "The current policy exceeds the 1 MiB Git sync limit",
    );

  let created: {
    full_name?: string;
    default_branch?: string;
    private?: boolean;
  };
  const repo = `${params.owner}/${params.name}`;
  let setupPullRequestNumber: number | undefined;
  let seededEmpty = false;
  // A policy kept elsewhere than appa.toml on the default branch is never a fresh copy.
  const validationDirectory =
    params.validationDirectory ?? VALIDATION_DIRECTORY;
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
      policy: policy.content,
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
      // A repository that already holds a policy becomes the policy source.
      return connectAppaGithubRepository({
        organizationId: params.organizationId,
        userId: params.userId,
        replace: params.replace,
        source: {
          repo,
          ref: params.ref ?? null,
          path: params.path ?? "appa.toml",
          interval: params.interval,
          githubPatId: null,
          githubAppConfigId,
          gitlabTokenId: null,
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
      const existing = await githubSetupRead<{ sha?: string }>({
        url: `${base}/contents/appa.toml?ref=${encodeURIComponent(created.default_branch)}`,
        token,
      });
      if (!existing.sha || !/^[a-f0-9]{40}$/.test(existing.sha))
        throw new ApiError(502, "The template has no appa.toml file");
      // Identical template bytes need no PR: GitHub cannot open an empty diff.
      const bytes = Buffer.from(policy.content);
      const policyBlob = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
      if (existing.sha !== policyBlob) {
        let requiresPullRequest = false;
        try {
          await githubJson({
            url: `${base}/contents/appa.toml`,
            token,
            method: "PUT",
            body: {
              message: "Seed current OpenAPPA policy",
              content: bytes.toString("base64"),
              sha: existing.sha,
              branch: created.default_branch,
            },
            errors: withGithubMessage((status, message) => {
              if (
                [403, 409, 422].includes(status) &&
                REPOSITORY_RULES.test(message ?? "")
              )
                return new GithubRepositoryRulesError();
              return new ApiError(
                502,
                `GitHub returned HTTP ${status} while committing the initial policy. Check repository access and App permissions.`,
              );
            }),
          });
        } catch (error) {
          if (!(error instanceof GithubRepositoryRulesError)) throw error;
          requiresPullRequest = true;
        }
        if (requiresPullRequest) {
          const branch = await githubSetupRead<{ object?: { sha?: string } }>({
            url: `${base}/git/ref/heads/${created.default_branch.split("/").map(encodeURIComponent).join("/")}`,
            token,
          });
          const sha = branch.object?.sha;
          if (!sha || !/^[a-f0-9]{40}$/.test(sha))
            throw new ApiError(
              502,
              "GitHub returned an invalid default branch",
            );
          const head = `archestra/openappa-setup-${randomUUID()}`;
          await githubJson({
            url: `${base}/git/refs`,
            token,
            method: "POST",
            body: { ref: `refs/heads/${head}`, sha },
            errors: githubSyncErrors,
          });
          await githubJson({
            url: `${base}/contents/appa.toml`,
            token,
            method: "PUT",
            body: {
              message: "Seed current OpenAPPA policy",
              content: bytes.toString("base64"),
              sha: existing.sha,
              branch: head,
            },
            errors: githubSyncErrors,
          });
          const pull = await githubJson<{ number?: number }>({
            url: `${base}/pulls`,
            token,
            method: "POST",
            errors: githubSyncErrors,
            body: {
              title: "Seed current OpenAPPA policy",
              body: "Review and merge this pull request to finish GitHub policy sync setup. Your current policy stays active until this pull request is merged.",
              head,
              base: created.default_branch,
            },
          });
          if (!Number.isSafeInteger(pull.number) || (pull.number ?? 0) <= 0)
            throw new ApiError(502, "GitHub returned an invalid pull request");
          setupPullRequestNumber = pull.number;
        }
      }
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
  await OpenAppaGithubSyncModel.save(params.organizationId, {
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
  });
  await syncAppaGithubPolicy(params.organizationId);
  return getAppaGithubSync(params.organizationId);
}

/**
 * The GitLab side of creating a policy repository: a new private project (or
 * an existing empty one) seeded from the bundled template, or an existing
 * project that already holds a policy connected as the source.
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
  const repo = params.owner ? `${params.owner}/${params.name}` : params.name;
  let seeded: { repo: string; branch: string };
  if (params.existing) {
    const status = await openappaGitlab.repositoryStatus({
      access,
      repo,
      ref: params.ref ?? undefined,
      path: params.path ?? "appa.toml",
      validationDirectory,
    });
    if (status.status !== "empty")
      return connectAppaGithubRepository({
        organizationId: params.organizationId,
        userId: params.userId,
        replace: params.replace,
        source: {
          repo,
          ref: params.ref ?? null,
          path: params.path ?? "appa.toml",
          interval: params.interval,
          githubPatId: null,
          githubAppConfigId: null,
          gitlabTokenId: params.gitlabTokenId,
          validationDirectory,
        },
      });
    seeded = {
      repo,
      ...(await openappaGitlab.seedExisting({
        access,
        repo,
        policy: policy.content,
      })),
    };
  } else {
    seeded = await openappaGitlab.createProject({
      access,
      namespace: params.owner || null,
      name: params.name,
      policy: policy.content,
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
  await OpenAppaGithubSyncModel.save(params.organizationId, {
    repo: seeded.repo,
    ref: seeded.branch,
    path: "appa.toml",
    interval: params.interval,
    githubPatId: null,
    githubAppConfigId: null,
    gitlabTokenId: params.gitlabTokenId,
    validationDirectory,
  });
  await syncAppaGithubPolicy(params.organizationId);
  return getAppaGithubSync(params.organizationId);
}

export async function updateAppaGithubSync(params: {
  organizationId: string;
  action: "sync" | "disconnect" | "schedule";
  interval?: AppaGithubSource["interval"];
}) {
  assertEnabled();
  const row = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (!row || row.interval === null)
    throw new ApiError(409, "Connect a GitHub source first");
  if (params.action === "sync")
    await syncAppaGithubPolicy(params.organizationId);
  else
    await OpenAppaGithubSyncModel.setInterval(
      params.organizationId,
      params.action === "disconnect" ? null : (params.interval ?? row.interval),
    );
  return getAppaGithubSync(params.organizationId);
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
        })
      : await readGithubPolicy({ row, repo, path });
    if (read.pending) {
      await OpenAppaGithubSyncModel.finish({
        organizationId,
        revision: row.revision,
        outcome: {
          error:
            read.pending === "closed"
              ? `The initial policy pull request was closed without merging. Reopen and merge it to finish setup, or stop syncing to keep managing the policy locally.`
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
  // Open pull requests get a pull's checks every minute, before they merge.
  await mapWithConcurrency(
    await OpenAppaGithubSyncModel.findConnected(),
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
 * ruleset that requires it: ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME, a
 * product-free name by default. A renamed deployment moves the ruleset and
 * its required check over at the next sync.
 */
const POLICY_CHECK_NAME = config.openappa.policyCheckName;

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
  /** The policy's own check, the deployment it was checked against, and when. */
  policy: Verdict & { deployment: string };
  /** Who asked, and whether they may change what the pull request changes. */
  authorship: Verdict;
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
  const refused = checkKey("refused", organizationId, source.repo);
  if (await cacheManager.get(refused)) return;
  let pulls: CheckedPull[];
  try {
    pulls = row.gitlabTokenId
      ? await gitlabPullRequests(source)
      : await githubPullRequests(source);
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
  const keys = checking.map((pull) =>
    checkKey(
      "checked",
      organizationId,
      source.repo,
      POLICY_CHECK_NAME,
      pull.head,
      pull.result,
    ),
  );
  const checked = await cacheManager.getMany<CheckedResult>(keys);
  for (const [index, pull] of checking.entries()) {
    const key = keys[index] as AllowedCacheKey;
    const stored = checked.get(key);
    // A result stored before authorship was checked is checked again whole.
    const previous = stored?.policy && stored.authorship ? stored : undefined;
    const now = Date.now();
    // The policy's check stands while the deployment it was checked against
    // does, a refusal for a while; authorship for a while either way.
    const policyStands =
      previous?.policy.deployment === deployment &&
      (previous.policy.accepted ||
        now - previous.policy.checkedAt < RECHECK_REFUSED);
    const authorshipStands =
      previous !== undefined &&
      now - previous.authorship.checkedAt < RECHECK_AUTHORSHIP;
    if (policyStands && authorshipStands) continue;
    const policy = policyStands
      ? previous.policy
      : verdict(await outcomeAt({ source, commitSha: pull.result }), {
          deployment,
          checkedAt: now,
        });
    // A read or a check that failed for now is checked again next minute.
    if (!policy) continue;
    const authorship = authorshipStands
      ? previous.authorship
      : verdict(
          pull.authorship ? await pull.authorship() : { accepted: true },
          {
            checkedAt: now,
          },
        );
    if (!authorship) continue;
    // The policy's own fault first: it is the one a reviewer fixes in the diff.
    const failed = [policy, authorship].find((check) => !check.accepted);
    const outcome: PullOutcome = failed
      ? {
          accepted: false,
          title: failed.title ?? undefined,
          reason: failed.reason ?? "",
        }
      : { accepted: true };
    const result: CheckedResult = {
      accepted: outcome.accepted,
      reason: outcome.accepted ? null : outcome.reason,
      policy,
      authorship,
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

/** A shared cache key for the policy check, from its parts. */
function checkKey(kind: "checked" | "refused", ...parts: string[]) {
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
  | { accepted: true }
  | { accepted: false; title?: string; reason: string };

type CheckedPull = {
  head: string;
  /** The commit checked: GitHub's merge result when it has one, else the head. */
  result: string;
  post: (outcome: PullOutcome) => Promise<void>;
  /**
   * Who asked for the change and whether they may make it; null for a read
   * that failed for now. Absent where the host cannot tell who asked.
   */
  authorship?: () => Promise<PullOutcome | null>;
};

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
          postGithubCheck({ base, token, head, appId, outcome }),
        ...(number
          ? {
              authorship: () =>
                githubAuthorship({
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
async function githubAuthorship(params: {
  source: PolicySource;
  token: string;
  api: string;
  base: string;
  number: number;
  user: GithubPullUser | null;
}): Promise<PullOutcome | null> {
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
      accepted: false,
      title: "This pull request changes too many files to check",
      reason: `${appName} checks who may change each file in a pull request of up to ${MAX_PULL_FILES} files. Split this one.`,
    };
  const governed = governedFiles(
    source,
    changed.flatMap((file) =>
      [file.filename, file.previous_filename].filter(
        (path): path is string => typeof path === "string",
      ),
    ),
  );
  if (governed.length === 0) return { accepted: true };
  const requester = await pullRequester({ ...params, governed });
  if (requester === null) return null;
  if ("refused" in requester) return requester.refused;
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
    const allowed = await (await port("scopedPermissions")).allows({
      organizationId: source.organizationId,
      userId,
      resource: "mcpRegistry",
      scope: catalogId,
      action: "update",
    });
    if (!allowed) {
      const catalog = await InternalMcpCatalogModel.findById(catalogId);
      return {
        accepted: false,
        title: "The requester may not change these rules",
        reason: `${email} may not change ${file.path}: that takes edit access to the MCP server ${catalog?.name ?? file.prefix} in the MCP registry.`,
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
        accepted: false,
        title: "The requester may not change the policy",
        reason: `${email} may not change ${first?.path ?? source.path}: that takes the guardrailsPolicy:update permission.`,
      };
    }
  }
  return { accepted: true };
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
  const seen = new Set<string>();
  return paths.flatMap((path) => {
    if (seen.has(path)) return [];
    seen.add(path);
    const relative = folder === "" ? path : path.slice(folder.length + 1);
    if (within(path, folder) && isServerRulesFile(relative))
      return [{ path, prefix: serverRulesPrefix(relative) }];
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
 * The member who asked for a pull request, or why that cannot be told. A
 * pull request opened by Archestra's own credential is read from its
 * commits; one opened by a person from the account they connected.
 */
async function pullRequester(params: {
  source: PolicySource;
  token: string;
  api: string;
  base: string;
  number: number;
  user: GithubPullUser | null;
  governed: Array<{ path: string }>;
}): Promise<
  { userId: string; email: string } | { refused: PullOutcome } | null
> {
  const { source, token, api, base, number, user } = params;
  const appName = archestraMcpBranding.appName;
  const own = await ownIdentity({ source });
  if (own === null) return null;
  const byArchestra =
    own !== undefined && own.login.toLowerCase() === user?.login?.toLowerCase();
  if (byArchestra) {
    const commits = await pagedGithub<{
      sha?: string;
      commit?: {
        author?: { email?: string };
        verification?: { verified?: boolean };
      };
      committer?: { login?: string } | null;
    }>({
      token,
      url: `${base}/pulls/${number}/commits`,
      max: MAX_PULL_COMMITS,
    });
    if (commits === null) return null;
    const foreign =
      commits === "over" ||
      commits.some(
        (entry) =>
          entry.commit?.verification?.verified !== true ||
          entry.committer?.login?.toLowerCase() !== own.login.toLowerCase(),
      );
    if (!foreign) {
      const emails = new Set(
        commits.map((entry) => entry.commit?.author?.email?.toLowerCase()),
      );
      const [email] = [...emails];
      const member =
        emails.size === 1 && email
          ? await MemberModel.findByIdOrEmail(email, source.organizationId)
          : null;
      if (member) return { userId: member.id, email: member.email };
      if (user?.type === "Bot")
        return {
          refused: {
            accepted: false,
            title: "Could not tell who asked for this change",
            reason: `${appName} opened this pull request for someone who is no longer a member. Propose the change again from the APPA Keeper or Settings → Guardrails.`,
          },
        };
    } else if (user?.type === "Bot")
      return {
        refused: {
          accepted: false,
          title: "Could not tell who asked for this change",
          reason: `This pull request has commits ${appName} did not make, so ${appName} cannot tell who asked for them. Propose the change again from the APPA Keeper or Settings → Guardrails, or open a pull request as yourself.`,
        },
      };
  }
  if (user?.type !== "User" || user.id === undefined)
    return {
      refused: {
        accepted: false,
        title: "Could not tell who asked for this change",
        reason: `This pull request was opened by ${user?.login ? `@${user.login}` : "an account"} that is not a person ${appName} knows. Propose the change from the APPA Keeper or Settings → Guardrails, or open a pull request as yourself.`,
      },
    };
  // The accounts Archestra holds are github.com's.
  const roster =
    api === "https://api.github.com"
      ? await RuntimeCredentialConnectionModel.listGitHubRoster(
          source.organizationId,
        )
      : new Map<unknown, string>();
  const email = [...roster.entries()].find(
    ([githubId]) => Number(githubId) === user.id,
  )?.[1];
  const member = email
    ? await MemberModel.findByIdOrEmail(email, source.organizationId)
    : null;
  if (!member)
    return {
      refused: {
        accepted: false,
        title: "Could not tell who asked for this change",
        reason: `@${user.login ?? user.id} has not connected a GitHub account in ${appName}, so ${appName} cannot tell whether they may change ${params.governed[0]?.path ?? source.path}. Connect one under Settings → Credentials, or ask an editor to propose the change from the APPA Keeper.`,
      },
    };
  return { userId: member.id, email: member.email };
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
      url: `${params.url}?per_page=100&page=${page}`,
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
    name: POLICY_CHECK_NAME,
    status: "completed",
    conclusion: outcome.accepted ? "success" : "failure",
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

async function gitlabPullRequests(
  source: PolicySource & { gitlabTokenId: string | null },
): Promise<CheckedPull[]> {
  if (!source.gitlabTokenId) return [];
  const client = gitClient(
    await resolveOpenAppaGitlabAccess({
      organizationId: source.organizationId,
      gitlabTokenId: source.gitlabTokenId,
    }),
  );
  const project = client.repoApi(source.repo);
  const requests = await (async () => {
    const branch = source.ref ?? (await client.defaultBranch(source.repo));
    return client.json<Array<{ sha?: string }>>(
      `${project}/merge_requests?state=opened&target_branch=${encodeURIComponent(branch)}&per_page=${MAX_CHECKED_PULLS}`,
    );
  })().catch((error) => {
    if (error instanceof GitHostError && [401, 403].includes(error.status))
      throw new CheckRefused(error.status);
    throw error;
  });
  return requests.flatMap((request) => {
    const head = request.sha;
    if (!head || !/^[a-f0-9]{40}$/.test(head)) return [];
    return [
      {
        head,
        result: head,
        post: async (outcome) => {
          const { title, summary } = checkSummary(outcome);
          await client
            .json(`${project}/statuses/${head}`, {
              body: {
                state: outcome.accepted ? "success" : "failed",
                name: POLICY_CHECK_NAME,
                description: (outcome.accepted ? title : summary).slice(0, 255),
              },
            })
            .catch((error) => {
              // A 404 can be a head pushed over since; only these refuse.
              if (
                error instanceof GitHostError &&
                [401, 403].includes(error.status)
              )
                throw new CheckRefused(error.status);
              throw error;
            });
        },
      },
    ];
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
class GithubRepositoryRulesError extends ApiError {
  constructor() {
    super(409, "GitHub repository rules block the initial policy commit");
  }
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
  const parentCommit = await githubJson<{ tree?: { sha?: string } }>({
    url: `${base}/git/commits/${parent}`,
    token,
    errors: githubSyncErrors,
  });
  const commitFiles = async (entries: typeof rest) => {
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
    return githubJson<{ sha: string }>({
      url: `${base}/git/commits`,
      token,
      method: "POST",
      body: {
        message: "Add the OpenAPPA template and current policy",
        tree: tree.sha,
        parents: [parent],
      },
      errors: githubSyncErrors,
    });
  };
  let outcome: "rules" | "workflow" | null = null;
  let commit = await commitFiles(rest);
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
          `GitHub returned HTTP ${status} while writing the template. Check repository access and App permissions.`,
        );
      }),
    });
  for (let attempt = 0; attempt < 2; attempt++) {
    outcome = null;
    try {
      await advance(commit.sha);
      return { branch };
    } catch (error) {
      if (outcome === "workflow" && attempt === 0) {
        commit = await commitFiles(
          rest.filter((file) => !file.path.startsWith(".github/")),
        );
        continue;
      }
      if (outcome !== "rules") throw error;
      const head = `archestra/openappa-setup-${randomUUID()}`;
      await githubJson({
        url: `${base}/git/refs`,
        token,
        method: "POST",
        body: { ref: `refs/heads/${head}`, sha: commit.sha },
        errors: githubSyncErrors,
      });
      const pull = await githubJson<{ number?: number }>({
        url: `${base}/pulls`,
        token,
        method: "POST",
        errors: githubSyncErrors,
        body: {
          title: "Add the OpenAPPA template and current policy",
          body: "Review and merge this pull request to finish GitHub policy sync setup. Your current policy stays active until this pull request is merged.",
          head,
          base: branch,
        },
      });
      if (!Number.isSafeInteger(pull.number) || (pull.number ?? 0) <= 0)
        throw new ApiError(502, "GitHub returned an invalid pull request");
      return { branch, setupPullRequestNumber: pull.number };
    }
  }
  throw new ApiError(502, "GitHub didn't accept the template");
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

/** The ruleset Archestra keeps on the synced branch: the check's name. */
const RULESET_NAME = POLICY_CHECK_NAME;

/** The permissions the GitHub App needs, each tried as its own job token. */
const GITHUB_APP_PERMISSIONS = [
  "contents",
  "pull_requests",
  "checks",
  "administration",
] as const;

export type RepositoryProtection = {
  /** The name of the policy check, and of the ruleset that requires it. */
  checkName: string;
  /**
   * The GitHub App's grants against what this feature needs, with where to
   * change them: an App created before a part existed is upgraded there.
   * Absent for GitLab.
   */
  app?: {
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
      | "disabled"
      | "needs_permission"
      | "unavailable"
      | "unsupported"
      | "error";
    url?: string;
    detail?: string;
    /** Bypass entries an administrator added on GitHub: they skip these rules. */
    bypassActors?: number;
    /**
     * The policy check while the App cannot post it: left out of the rules
     * until it can ("omitted"), or required by a rule it cannot satisfy, so
     * pull requests wait on it ("unposted"). Absent while the check is posted.
     */
    checkRule?: "omitted" | "unposted";
  };
};

/**
 * The policy repository's protection, and with `apply` the changes that bring
 * it in line: a branch ruleset that requires a pull request, up to date, with
 * the policy check, which is where who may change each file is decided.
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
  if (!row?.interval || !row.repo || !row.path || !row.sourceCommit)
    return null;
  if (row.gitlabTokenId)
    return {
      checkName: POLICY_CHECK_NAME,
      branchRules: {
        state: "unsupported",
        detail: `${archestraMcpBranding.appName} keeps branch rules on GitHub repositories only; protect the GitLab branch in its settings.`,
      },
    };
  const source = {
    ...row,
    repo: row.repo,
    path: row.path,
    sourceCommit: row.sourceCommit,
  };
  const [branchRules, app] = await Promise.all([
    githubBranchRules(source, params.apply).catch((error) => ({
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
  return { checkName: POLICY_CHECK_NAME, ...(app ? { app } : {}), branchRules };
}

/** The last protection read or applied, by organization, for a minute. */
const protectionStatus = new LRUCacheManager<RepositoryProtection | null>({
  maxSize: 1024,
  defaultTtl: 60_000,
});

/**
 * The repository's protection as the Git sync settings show it: read at most
 * once a minute, and replaced by what each sync applies.
 */
export async function getRepositoryProtection(
  organizationId: string,
): Promise<RepositoryProtection | null> {
  const cached = protectionStatus.get(organizationId);
  if (cached !== undefined) return cached;
  const read = await repositoryProtection({ organizationId, apply: false });
  protectionStatus.set(organizationId, read);
  return read;
}

/** Bring the repository's protection in line, as each sync does. */
async function maintainRepositoryProtection(
  organizationId: string,
): Promise<RepositoryProtection | null> {
  const applied = await repositoryProtection({ organizationId, apply: true });
  protectionStatus.set(organizationId, applied);
  return applied;
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
): Promise<RepositoryProtection["app"]> {
  if (!source.githubAppConfigId) return undefined;
  const profile = await githubAppProfile(source);
  if (!profile) return undefined;
  const permissions = await Promise.all(
    GITHUB_APP_PERMISSIONS.map(async (name) => {
      try {
        await resolveOpenAppaGithubAccess(source, { [name]: "write" });
        return { name, granted: true };
      } catch (error) {
        if (error instanceof MissingGithubPermission)
          return { name, granted: false };
        throw error;
      }
    }),
  );
  return {
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
  // Ours by name, or by the check it requires from this App: a deployment
  // renamed since (ARCHESTRA_OPENAPPA_POLICY_CHECK_NAME) finds its ruleset
  // again and renames it, instead of leaving one that holds every pull request.
  let ours = repositoryRulesets.find(
    (ruleset) => ruleset.name === RULESET_NAME,
  );
  let existing: Awaited<ReturnType<typeof githubCall<Ruleset>>> | null = null;
  if (!ours && integrationId) {
    for (const candidate of repositoryRulesets.slice(0, 25)) {
      const read = await githubCall<Ruleset>({
        token,
        url: `${base}/rulesets/${candidate.id}`,
      });
      if (read.ok && requiresCheckFrom(read.body.rules, integrationId)) {
        ours = candidate;
        existing = read;
        break;
      }
    }
  }
  // The check is required only while this App may post it: a required check
  // nobody posts holds every pull request for good.
  const check = await policyCheckAccess(source);
  const desired = desiredRuleset({
    branch,
    integrationId,
    requireCheck: check.postable,
  });
  const checkGap = (
    rules: Rule[] | undefined,
  ): Pick<RepositoryProtection["branchRules"], "checkRule" | "detail"> =>
    check.postable
      ? {}
      : {
          checkRule: requiresPolicyCheck(rules) ? "unposted" : "omitted",
          detail: check.detail,
        };
  const page = (id: number) => `${web}/${source.repo}/rules/${id}`;
  if (!ours) {
    if (!apply) return { state: "missing" };
    const created = await githubCall<{ id: number }>({
      token,
      url: `${base}/rulesets`,
      method: "POST",
      body: desired,
    });
    if (!created.ok) return unavailable(created);
    return {
      state: "active",
      url: page(created.body.id),
      ...checkGap(desired.rules),
    };
  }
  existing ??= await githubCall<Ruleset>({
    token,
    url: `${base}/rulesets/${ours.id}`,
  });
  if (!existing.ok) return unavailable(existing);
  // Disabled or in evaluate mode on GitHub: an administrator's choice to keep.
  if (existing.body.enforcement !== "active")
    return {
      state: "disabled",
      url: page(ours.id),
      detail: `The ruleset is ${existing.body.enforcement} on GitHub, so ${archestraMcpBranding.appName} leaves it as it is.`,
    };
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
    ...checkGap(existing.body.rules),
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
 * Whether the source's credential may post the policy check: a token posts
 * a commit status; a GitHub App needs Checks and Pull requests, and one not
 * granted them says so.
 */
async function policyCheckAccess(
  source: ConnectedSource,
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
        detail: `The GitHub App cannot post the ${POLICY_CHECK_NAME} check: ${error.message}`,
      };
    throw error;
  }
}

/** Whether a rule requires a check from this App, under any name. */
function requiresCheckFrom(
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

/** Whether a rule requires the policy check, under any App. */
function requiresPolicyCheck(rules: Rule[] | undefined): boolean {
  return (rules ?? []).some(
    (rule) =>
      rule.type === "required_status_checks" &&
      (
        (rule.parameters?.required_status_checks ?? []) as Array<{
          context?: string;
        }>
      ).some((check) => check.context === POLICY_CHECK_NAME),
  );
}

/**
 * The ruleset Archestra keeps: a pull request, the policy check on a branch
 * that is up to date, and no force push or deletion. No approval: the check
 * decides whether the person who asked may change each file, so a server's
 * only editor merges their own change. An administrator who wants a second
 * pair of eyes raises the approval count on GitHub, and it stays. Archestra
 * adds no one who may bypass it, itself included. Up to date, because the
 * check stands for the merge result it saw: once the branch moves, a pull
 * request merges only after it is updated and its new result checked.
 */
function desiredRuleset(params: {
  branch: string;
  integrationId?: number;
  /** Whether to require the policy check: only while the App may post it. */
  requireCheck: boolean;
}): Ruleset & { bypass_actors: unknown[]; rules: Rule[] } {
  const checkRule: Rule = {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [
        {
          context: POLICY_CHECK_NAME,
          // Only this App's check counts: no one posts a passing one
          // with a token of their own.
          ...(params.integrationId
            ? { integration_id: params.integrationId }
            : {}),
        },
      ],
    },
  };
  return {
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: [`refs/heads/${params.branch}`], exclude: [] },
    },
    bypass_actors: [],
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: false,
        },
      },
      ...(params.requireCheck ? [checkRule] : []),
    ],
  };
}

/**
 * The existing ruleset with Archestra's rules added where missing or weaker,
 * or null when it already has them. What an administrator made stricter, or
 * added, stays, bypass entries included; an exclusion that leaves the synced
 * branch out does not.
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
    if (wanted.type === "pull_request") {
      // Approvals and reviews are the administrator's to require; a stale
      // approval must not outlive the push it approved.
      const parameters = have.parameters ?? {};
      const next = {
        ...parameters,
        required_approving_review_count: Number(
          parameters.required_approving_review_count ?? 0,
        ),
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review:
          parameters.require_code_owner_review === true,
        require_last_push_approval:
          parameters.require_last_push_approval === true,
        required_review_thread_resolution:
          parameters.required_review_thread_resolution === true,
      };
      if (
        parameters.dismiss_stale_reviews_on_push !== true ||
        [
          "required_approving_review_count",
          "require_code_owner_review",
          "require_last_push_approval",
          "required_review_thread_resolution",
        ].some((name) => parameters[name] === undefined)
      ) {
        rules[at] = { type: have.type, parameters: next };
        changed = true;
      }
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
      const strict =
        have.parameters?.strict_required_status_checks_policy === true;
      if (!present || !strict || renamed.length > 0) {
        const kept = checks.filter(
          (check) => check.context !== ours.context && !renamed.includes(check),
        );
        rules[at] = {
          type: have.type,
          parameters: {
            ...have.parameters,
            strict_required_status_checks_policy: true,
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
  if (!changed) return null;
  return {
    name: desired.name,
    target: existing.target,
    enforcement: existing.enforcement,
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
}): RepositoryProtection["branchRules"] {
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
