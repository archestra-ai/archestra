import { createHash, randomUUID } from "node:crypto";
import {
  getGithubWebOrigin,
  gitHostFromUrl,
  isBuiltInCatalogId,
  type ResourcePermissionGrant,
  slugifyMcpServerName,
  TimeInMs,
} from "@archestra/shared";
import { inArray } from "drizzle-orm";
import { userHasPermission } from "@/auth";
import { LRUCacheManager } from "@/cache-manager";
import db, { schema } from "@/database";
import { enterpriseTier } from "@/enterprise-tier";
import { gitClient } from "@/git-hosts/git-access";
import logger from "@/logging";
import { RuntimeCredentialDefinitionModel } from "@/models";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import TeamModel from "@/models/team";
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
  parsePolicyToml,
  repositoryIncludePaths,
  SERVER_RULES_INCLUDE,
  serverRulesPath,
  withoutRepositoryIncludes,
} from "@/openappa/policy-text";
import { OPENAPPA_TEMPLATE } from "@/openappa/template.generated";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import {
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
        onHttpError: (status) =>
          new ApiError(
            status === 422 ? 409 : 502,
            status === 422
              ? `GitHub rejected ${repo} (HTTP 422). If this is a new repository from an earlier attempt, retry setup after the App can access it. Otherwise choose a different name.`
              : status === 404
                ? `GitHub could not create a repository under ${params.owner} (HTTP 404). Check that the selected App is installed on that exact account with All repositories access and the required permissions.`
                : `GitHub returned HTTP ${status} while creating ${repo}. Check the App installation and permissions.`,
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
            onHttpError: (status, message) => {
              if (
                [403, 409, 422].includes(status) &&
                REPOSITORY_RULES.test(message ?? "")
              )
                return new GithubRepositoryRulesError();
              return new ApiError(
                502,
                `GitHub returned HTTP ${status} while committing the initial policy. Check repository access and App permissions.`,
              );
            },
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
          });
          const pull = await githubJson<{ number?: number }>({
            url: `${base}/pulls`,
            token,
            method: "POST",
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
  // in line: their code owners and the branch ruleset. A failure there shows
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
      return { valid: false, errors: [] };
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
  } catch {
    logger.warn(
      { organizationId },
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

/** The check every policy pull request carries; the branch ruleset requires it. */
const POLICY_CHECK_NAME = "Archestra Guardrails policy";

/** The most open pull requests checked in one repository each minute. */
const MAX_CHECKED_PULLS = 50;

/**
 * Pull request results checked already, by repository, head and the merge
 * result checked: a new commit on either side is checked again, nothing else.
 */
const checkedPulls = new LRUCacheManager<true>({
  maxSize: 4096,
  defaultTtl: TimeInMs.Day,
});

/**
 * A repository that refused a check, for ten minutes: a credential without
 * the permission is not asked again every minute.
 */
const refusedChecks = new LRUCacheManager<true>({
  maxSize: 512,
  defaultTtl: 10 * TimeInMs.Minute,
});

/**
 * Check every open pull request (merge request on GitLab) into the synced
 * branch as a pull would check its result, and post the outcome on its head
 * commit as the "Archestra Guardrails policy" check. A branch rule that
 * requires the check stops a merge Git sync would refuse; without one, the
 * reviewers still see it.
 */
async function checkAppaGithubPullRequests(organizationId: string) {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row?.repo || !row.path || !row.interval || !row.sourceCommit) return;
  const source = { ...row, repo: row.repo, path: row.path };
  const repository = [organizationId, source.repo].join("\u0000");
  if (refusedChecks.get(repository)) return;
  let pulls: CheckedPull[];
  try {
    pulls = row.gitlabTokenId
      ? await gitlabPullRequests(source)
      : await githubPullRequests(source);
  } catch (error) {
    if (!(error instanceof MissingGithubPermission)) throw error;
    refusedChecks.set(repository, true);
    logger.warn(
      { organizationId, error: error.message },
      "OpenAPPA cannot check the policy repository's pull requests",
    );
    return;
  }
  for (const pull of pulls.slice(0, MAX_CHECKED_PULLS)) {
    const key = [organizationId, source.repo, pull.head, pull.result].join(
      "\u0000",
    );
    if (checkedPulls.get(key)) continue;
    const outcome = await outcomeAt({ source, commitSha: pull.result });
    // A read that failed for now is checked again next minute.
    if (!outcome) continue;
    try {
      await pull.post(outcome);
    } catch (error) {
      refusedChecks.set(repository, true);
      logger.warn(
        { organizationId, error },
        "OpenAPPA could not post the policy check on a pull request: a GitHub App needs the Checks permission (read and write), a token the commit statuses scope",
      );
      return;
    }
    checkedPulls.set(key, true);
  }
}

type PullOutcome = { accepted: true } | { accepted: false; reason: string };

type CheckedPull = {
  head: string;
  /** The commit checked: GitHub's merge result when it has one, else the head. */
  result: string;
  post: (outcome: PullOutcome) => Promise<void>;
};

type PolicySource = RepositorySource & {
  path: string;
  ref: string | null;
};

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
        summary:
          "Archestra checked the policy this pull request would merge, with every file it includes, as Git sync checks a commit before applying it.",
      }
    : {
        title: "Git sync would refuse this policy",
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
  const branch =
    source.ref ??
    (await githubJson<{ default_branch: string }>({ url: base, token }))
      .default_branch;
  const pulls = await githubJson<
    Array<{ head?: { sha?: string }; merge_commit_sha?: string | null }>
  >({
    url: `${base}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=${MAX_CHECKED_PULLS}`,
    token,
  });
  return pulls.flatMap((pull) => {
    const head = pull.head?.sha;
    if (!head || !/^[a-f0-9]{40}$/.test(head)) return [];
    const merged = pull.merge_commit_sha;
    return [
      {
        head,
        result: merged && /^[a-f0-9]{40}$/.test(merged) ? merged : head,
        post: (outcome) => postGithubCheck({ base, token, head, outcome }),
      },
    ];
  });
}

/**
 * A check run where the credential may create one, a GitHub App with the
 * Checks permission; otherwise a commit status, which reads the same.
 */
async function postGithubCheck(params: {
  base: string;
  token: string;
  head: string;
  outcome: PullOutcome;
}) {
  const { base, token, head, outcome } = params;
  const { title, summary } = checkSummary(outcome);
  let refused = false;
  try {
    await githubJson({
      url: `${base}/check-runs`,
      token,
      method: "POST",
      body: {
        name: POLICY_CHECK_NAME,
        head_sha: head,
        status: "completed",
        conclusion: outcome.accepted ? "success" : "failure",
        output: { title, summary: summary.slice(0, 60_000) },
      },
      onHttpError: (status) => {
        refused = status === 403 || status === 404;
        return new ApiError(502, `GitHub returned HTTP ${status}`);
      },
    });
    return;
  } catch (error) {
    if (!refused) throw error;
  }
  await githubJson({
    url: `${base}/statuses/${head}`,
    token,
    method: "POST",
    body: {
      state: outcome.accepted ? "success" : "failure",
      context: POLICY_CHECK_NAME,
      description: (outcome.accepted ? title : summary).slice(0, 140),
    },
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
  const branch = source.ref ?? (await client.defaultBranch(source.repo));
  const requests = await client.json<Array<{ sha?: string }>>(
    `${project}/merge_requests?state=opened&target_branch=${encodeURIComponent(branch)}&per_page=${MAX_CHECKED_PULLS}`,
  );
  return requests.flatMap((request) => {
    const head = request.sha;
    if (!head || !/^[a-f0-9]{40}$/.test(head)) return [];
    return [
      {
        head,
        result: head,
        post: async (outcome) => {
          const { title, summary } = checkSummary(outcome);
          await client.json(`${project}/statuses/${head}`, {
            body: {
              state: outcome.accepted ? "success" : "failed",
              name: POLICY_CHECK_NAME,
              description: (outcome.accepted ? title : summary).slice(0, 255),
            },
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
    const response = await githubFetch(
      `${api}/repos/${params.source.repo}/commits/${encodeURIComponent(params.source.ref ?? "HEAD")}`,
      {
        Accept: "application/vnd.github+json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    );
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
  const headers = {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const base = `${api}/repos/${repo}`;
  if (row.setupPullRequestNumber) {
    const pull = await githubJson<{ merged?: boolean; state?: string }>({
      url: `${base}/pulls/${row.setupPullRequestNumber}`,
      token: token ?? "",
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
  const commitResponse = await githubFetch(
    `${base}/commits/${encodeURIComponent(row.ref ?? "HEAD")}`,
    headers,
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
  const response = await githubFetch(
    `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit.sha}`,
    { ...headers, Accept: "application/vnd.github.raw+json" },
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
async function githubFetch(
  url: string,
  headers: Record<string, string>,
  notFound?: string,
) {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404 && notFound) throw new ApiError(400, notFound);
  if (!response.ok)
    throw new ApiError(
      400,
      `GitHub returned HTTP ${response.status}. Check repository access and the source path.`,
    );
  return response;
}

async function githubJson<T = unknown>(params: {
  url: string;
  token: string;
  method?: "GET" | "POST" | "PUT" | "PATCH";
  body?: object;
  onHttpError?: (status: number, message?: string) => ApiError;
}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(params.url, {
      method: params.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${params.token}`,
        ...(params.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(params.body ? { body: JSON.stringify(params.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(502, "Could not reach GitHub");
  }
  if (!response.ok) {
    const errorBody = await readResponseBodyWithLimit(response, 4096);
    let message: string | undefined;
    if (errorBody) {
      try {
        const parsed = JSON.parse(errorBody.toString()) as {
          message?: unknown;
        };
        if (typeof parsed.message === "string")
          message = parsed.message.slice(0, 200);
      } catch {
        // GitHub does not always return JSON for upstream failures.
      }
    }
    throw (
      params.onHttpError?.(response.status, message) ??
      new ApiError(
        response.status === 422 ? 409 : 502,
        `GitHub returned HTTP ${response.status}. Check repository access and App permissions.`,
      )
    );
  }
  const bytes = await readResponseBodyWithLimit(response, 2 * 1024 * 1024);
  if (!bytes) throw new ApiError(502, "GitHub response is too large");
  try {
    return JSON.parse(bytes.toString()) as T;
  } catch {
    throw new ApiError(502, "GitHub returned an invalid response");
  }
}

class GithubRepositoryRulesError extends ApiError {
  constructor() {
    super(409, "GitHub repository rules block the initial policy commit");
  }
}

// Template generation can return before its files and branch are readable.
async function githubSetupRead<T>(params: {
  url: string;
  token: string;
}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await githubJson<T>(params);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        ![409, 502].includes(error.statusCode) ||
        attempt === 3
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
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
      }),
      githubJson<{ sha?: string }>({
        url: `${params.api}/repos/${TEMPLATE_REPO}/contents/appa.toml`,
        token: params.token,
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

/** GitHub answers 409 for the commits of a repository without any. */
async function isEmptyGithubRepository(params: {
  api: string;
  repo: string;
  token: string;
}) {
  const response = await fetch(
    `${params.api}/repos/${params.repo}/commits?per_page=1`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${params.token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  ).catch(() => null);
  return response?.status === 409;
}

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
      onHttpError: (status, message) => {
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
      },
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
      });
      const pull = await githubJson<{ number?: number }>({
        url: `${base}/pulls`,
        token,
        method: "POST",
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
  ).catch((error) => {
    if (error instanceof MissingGithubPermission) throw error;
    throw new ApiError(400, "The configured GitHub credential is unavailable");
  });
  const signal = AbortSignal.timeout(20000);
  const base = `${api}/repos/${source.repo}/contents/`;
  const headers = {
    Accept: "application/vnd.github+json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const read = async (path: string, raw: boolean, limit: number) => {
    const response = await fetch(
      `${base}${path.split("/").map(encodeURIComponent).join("/")}?ref=${source.sourceCommit}`,
      {
        headers: {
          ...headers,
          ...(raw ? { Accept: "application/vnd.github.raw+json" } : {}),
        },
        redirect: "error",
        signal,
      },
    );
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

/**
 * Where Archestra's lines sit in CODEOWNERS. Everything between the markers
 * is rewritten from the registry; everything else is the repository's own.
 */
const OWNERS_BEGIN = "# BEGIN Archestra: MCP server rules owners";
const OWNERS_END = "# END Archestra: MCP server rules owners";

/** The branch of the one code owners pull request Archestra keeps open. */
const OWNERS_BRANCH = "archestra/openappa-code-owners";

/** Where GitHub reads CODEOWNERS from, in its own order. */
const CODEOWNERS_PATHS = [
  ".github/CODEOWNERS",
  "CODEOWNERS",
  "docs/CODEOWNERS",
] as const;

/**
 * Beside appa.toml: the GitHub owner of each Archestra team and role, and of
 * a person who has not connected GitHub. Reviewed like any other file.
 */
const OWNERS_MAP_FILE = "code-owners.toml";

/** The ruleset Archestra keeps on the synced branch. */
const RULESET_NAME = "Archestra Guardrails policy";

/** A GitHub user (`@login`) or team (`@org/team`) as CODEOWNERS names one. */
const GITHUB_OWNER =
  /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

export type RepositoryProtection = {
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
  };
  /** The CODEOWNERS lines for server rules files. */
  codeOwners: {
    state:
      | "up_to_date"
      | "pull_request"
      | "out_of_date"
      | "not_used"
      | "needs_permission"
      | "unsupported"
      | "error";
    url?: string;
    detail?: string;
    /** Servers whose editors have no GitHub owner, with the editors unmapped. */
    unowned: Array<{ server: string; editors: string[] }>;
    /** Problems in the owners map. */
    mapErrors: string[];
  };
};

/**
 * The policy repository's protection for server rules files, and with
 * `apply` the changes that bring it in line: a CODEOWNERS block naming each
 * server's editors, proposed as one pull request, and a branch ruleset that
 * requires a pull request, code owner review and the policy check. Nothing
 * merges here: the code owners change is reviewed like any other.
 *
 * Each part works with its own token, limited to the policy repository and to
 * what it does: the ruleset with Administration, the code owners with
 * Contents and Pull requests. A permission the App was not granted is
 * reported, not raised.
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
      branchRules: {
        state: "unsupported",
        detail:
          "Archestra keeps branch rules on GitHub repositories only; protect the GitLab branch in its settings.",
      },
      codeOwners: {
        state: "unsupported",
        detail:
          "Archestra writes code owners on GitHub repositories only; GitLab keeps its own CODEOWNERS.",
        unowned: [],
        mapErrors: [],
      },
    };
  const source = {
    ...row,
    repo: row.repo,
    path: row.path,
    sourceCommit: row.sourceCommit,
  };
  const [branchRules, codeOwners] = await Promise.all([
    githubBranchRules(source, params.apply).catch((error) => ({
      state: "error" as const,
      detail: protectionError(error),
    })),
    githubCodeOwners(source, params.apply).catch((error) => ({
      state: "error" as const,
      detail: protectionError(error),
      unowned: [],
      mapErrors: [],
    })),
  ]);
  return { branchRules, codeOwners };
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
  const ours = rulesets.body.find(
    (ruleset) =>
      ruleset.name === RULESET_NAME &&
      (ruleset.source_type ?? "Repository") === "Repository",
  );
  const desired = desiredRuleset({
    branch,
    integrationId: await checkIntegrationId(source),
  });
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
    return { state: "active", url: page(created.body.id) };
  }
  const existing = await githubCall<Ruleset>({
    token,
    url: `${base}/rulesets/${ours.id}`,
  });
  if (!existing.ok) return unavailable(existing);
  // Disabled or in evaluate mode on GitHub: an administrator's choice to keep.
  if (existing.body.enforcement !== "active")
    return {
      state: "disabled",
      url: page(ours.id),
      detail: `The ruleset is ${existing.body.enforcement} on GitHub, so Archestra leaves it as it is.`,
    };
  const strengthened = strengthenedRuleset(existing.body, desired);
  if (!strengthened) return { state: "active", url: page(ours.id) };
  if (!apply) return { state: "incomplete", url: page(ours.id) };
  const updated = await githubCall({
    token,
    url: `${base}/rulesets/${ours.id}`,
    method: "PUT",
    body: strengthened,
  });
  if (!updated.ok) return unavailable(updated);
  return { state: "active", url: page(ours.id) };
}

/**
 * The ruleset Archestra keeps: a pull request with a code owner's approval
 * of its latest push, the policy check, and no force push or deletion. No
 * one bypasses it, Archestra included.
 */
function desiredRuleset(params: {
  branch: string;
  integrationId?: number;
}): Ruleset & { bypass_actors: unknown[]; rules: Rule[] } {
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
          required_approving_review_count: 1,
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: true,
          require_last_push_approval: true,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: false,
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
      },
    ],
  };
}

/**
 * The existing ruleset with Archestra's rules added where missing or weaker,
 * or null when it already has them. What an administrator made stricter, or
 * added, stays.
 */
function strengthenedRuleset(
  existing: Ruleset,
  desired: ReturnType<typeof desiredRuleset>,
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
      const parameters = have.parameters ?? {};
      const count = Number(parameters.required_approving_review_count ?? 0);
      const next = {
        ...parameters,
        required_approving_review_count: Math.max(count, 1),
        dismiss_stale_reviews_on_push: true,
        require_code_owner_review: true,
        require_last_push_approval: true,
        required_review_thread_resolution:
          parameters.required_review_thread_resolution ?? false,
      };
      if (
        count < 1 ||
        parameters.dismiss_stale_reviews_on_push !== true ||
        parameters.require_code_owner_review !== true ||
        parameters.require_last_push_approval !== true ||
        parameters.required_review_thread_resolution === undefined
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
      if (!present) {
        rules[at] = {
          type: have.type,
          parameters: {
            ...have.parameters,
            strict_required_status_checks_policy:
              have.parameters?.strict_required_status_checks_policy ?? false,
            required_status_checks: [
              ...checks.filter((check) => check.context !== ours.context),
              ours,
            ],
          },
        };
        changed = true;
      }
    }
  }
  const include = existing.conditions?.ref_name?.include ?? [];
  const branch = desired.conditions?.ref_name?.include?.[0] as string;
  const covers = include.includes(branch) || include.includes("~ALL");
  if (!covers) changed = true;
  if (!changed) return null;
  return {
    name: existing.name,
    target: existing.target,
    enforcement: existing.enforcement,
    conditions: {
      ref_name: {
        include: covers ? include : [...include, branch],
        exclude: existing.conditions?.ref_name?.exclude ?? [],
      },
    },
    bypass_actors: existing.bypass_actors ?? [],
    rules,
  };
}

/** The App whose check the ruleset requires, or none for a token. */
async function checkIntegrationId(
  source: ConnectedSource,
): Promise<number | undefined> {
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

// === Code owners ===

type OwnersMap = {
  teams: Map<string, string[]>;
  roles: Map<string, string[]>;
  users: Map<string, string[]>;
  errors: string[];
};

async function githubCodeOwners(
  source: ConnectedSource,
  apply: boolean,
): Promise<RepositoryProtection["codeOwners"]> {
  const root = await guardrailsPolicyService.get(source.organizationId);
  const used = repositoryIncludePaths(root.content).some(
    (entry) => entry === SERVER_RULES_INCLUDE || isServerRulesFile(entry),
  );
  if (!used) return { state: "not_used", unowned: [], mapErrors: [] };
  let access: Awaited<ReturnType<typeof resolveOpenAppaGithubAccess>>;
  try {
    access = await resolveOpenAppaGithubAccess(source, {
      contents: "write",
      pull_requests: "write",
    });
  } catch (error) {
    if (error instanceof MissingGithubPermission)
      return {
        state: "needs_permission",
        detail: error.message,
        unowned: [],
        mapErrors: [],
      };
    throw error;
  }
  const { token, api } = access;
  if (!token)
    return {
      state: "needs_permission",
      detail:
        "The policy repository is read without a credential. Connect a GitHub App in Git sync.",
      unowned: [],
      mapErrors: [],
    };
  const map = parseOwnersMap(
    (
      await openappaRepositoryIncludes.read({
        source,
        commit: source.sourceCommit,
        paths: [OWNERS_MAP_FILE],
      })
    ).get(OWNERS_MAP_FILE),
  );
  const servers = await serverEditors(source.organizationId);
  const connected = await connectedLogins({
    organizationId: source.organizationId,
    api,
    token,
    users: servers.flatMap((server) => server.users),
  });
  const lines: string[] = [];
  const unowned: RepositoryProtection["codeOwners"]["unowned"] = [];
  for (const server of servers) {
    const owners = new Set<string>();
    const unmapped: string[] = [];
    const add = (found: string[] | undefined, name: string) => {
      if (found?.length) for (const owner of found) owners.add(owner);
      else unmapped.push(name);
    };
    for (const team of server.teams) add(map.teams.get(team), `team ${team}`);
    for (const role of server.roles)
      add(map.roles.get(role), role === "*" ? "everyone" : `role ${role}`);
    for (const user of server.users) {
      const login =
        map.users.get(user.email.toLowerCase()) ??
        (connected.get(user.id) ? [`@${connected.get(user.id)}`] : undefined);
      add(login, user.email);
    }
    if (owners.size > 0)
      lines.push(
        `/${repositoryPath(source, server.path)} ${[...owners].sort().join(" ")}`,
      );
    if (unmapped.length > 0)
      unowned.push({ server: server.name, editors: unmapped });
  }
  lines.sort();
  const current = await currentCodeOwners(source);
  const next = withOwnersBlock(current?.content ?? null, lines);
  const base = `${api}/repos/${source.repo}`;
  const open = await openOwnersPull({ token, base, repo: source.repo });
  const result = { unowned, mapErrors: map.errors };
  if (next === (current?.content ?? null)) {
    // Nothing left to propose: a pull request still open has nothing to add.
    if (open && apply)
      await closeOwnersPull({ token, base, number: open.number });
    return { state: "up_to_date", ...result };
  }
  const file = current?.path ?? CODEOWNERS_PATHS[0];
  if (open) {
    const proposed = (
      await openappaRepositoryIncludes.read({
        source: { ...source, path: null },
        commit: open.head,
        paths: [file],
      })
    ).get(file);
    if (proposed === next || !apply)
      return { state: "pull_request", url: open.url, ...result };
  } else if (!apply) return { state: "out_of_date", ...result };
  const pull = await proposeOwners({
    source,
    token,
    base,
    file,
    content: next,
    open,
    lines,
    unowned,
    mapErrors: map.errors,
  });
  return { state: "pull_request", url: pull.url, ...result };
}

/** The owners map in `code-owners.toml`, or an empty one with what is wrong. */
function parseOwnersMap(text: string | undefined): OwnersMap {
  const map: OwnersMap = {
    teams: new Map(),
    roles: new Map(),
    users: new Map(),
    errors: [],
  };
  if (text === undefined) return map;
  const document = parsePolicyToml(text);
  if (!document) {
    map.errors.push(`${OWNERS_MAP_FILE} is not valid TOML`);
    return map;
  }
  for (const [section, target] of [
    ["teams", map.teams],
    ["roles", map.roles],
    ["users", map.users],
  ] as const) {
    const table = asRecord(document[section]);
    if (document[section] !== undefined && !table) {
      map.errors.push(`${OWNERS_MAP_FILE}: [${section}] must be a table`);
      continue;
    }
    for (const [name, value] of Object.entries(table ?? {})) {
      const owners = (Array.isArray(value) ? value : [value]).filter(
        (owner): owner is string => typeof owner === "string",
      );
      const invalid = owners.filter((owner) => !GITHUB_OWNER.test(owner));
      if (owners.length === 0 || invalid.length > 0) {
        map.errors.push(
          `${OWNERS_MAP_FILE}: ${section}.${JSON.stringify(name)} must name GitHub users or teams as "@login" or "@org/team"`,
        );
        continue;
      }
      target.set(section === "users" ? name.toLowerCase() : name, owners);
    }
  }
  for (const key of Object.keys(document))
    if (!["teams", "roles", "users"].includes(key))
      map.errors.push(
        `${OWNERS_MAP_FILE} may hold only [teams], [roles] and [users]; it sets ${key}`,
      );
  return map;
}

/**
 * Every server with a rules file of its own, and who may edit it: the teams
 * (by name), roles, and people its own edit grants name. A grant to the whole
 * organization reads as the role "*". Grants to every server in the registry
 * are the administrators' and stay with the fallback owners.
 */
async function serverEditors(organizationId: string): Promise<
  Array<{
    name: string;
    path: string;
    teams: string[];
    roles: string[];
    users: Array<{ id: string; email: string }>;
  }>
> {
  const prefixes = await catalogToolPrefixes(organizationId);
  const ids = [...prefixes.byCatalog.keys()].filter(
    (id) => !isBuiltInCatalogId(id),
  );
  if (ids.length === 0) return [];
  const catalogs = (
    await db
      .select({
        id: schema.internalMcpCatalogTable.id,
        name: schema.internalMcpCatalogTable.name,
      })
      .from(schema.internalMcpCatalogTable)
      .where(inArray(schema.internalMcpCatalogTable.id, ids))
  ).filter((catalog) => hasOwnFile(catalog, prefixes));
  const policies = (
    await ResourcePermissionPolicyModel.findObjectPolicies({
      resources: ["mcpRegistry"],
      scopes: catalogs.map((catalog) => catalog.id),
    })
  ).filter((policy) => policy.organizationId === organizationId);
  const grants = new Map(
    policies.map((policy) => [
      policy.scope,
      (policy.grants as ResourcePermissionGrant[]).filter((grant) =>
        grant.actions.includes("update"),
      ),
    ]),
  );
  const subjects = [...grants.values()].flat().map((grant) => grant.subject);
  const teamIds = [
    ...new Set(
      subjects.flatMap((subject) =>
        subject.type === "team" ? [subject.id] : [],
      ),
    ),
  ];
  const userIds = [
    ...new Set(
      subjects.flatMap((subject) =>
        subject.type === "user" ? [subject.id] : [],
      ),
    ),
  ];
  const [teams, users] = await Promise.all([
    teamIds.length > 0 ? TeamModel.findByIds(teamIds) : [],
    userIds.length > 0
      ? db
          .select({ id: schema.usersTable.id, email: schema.usersTable.email })
          .from(schema.usersTable)
          .where(inArray(schema.usersTable.id, userIds))
      : [],
  ]);
  const teamName = new Map(
    teams
      .filter((team) => team.organizationId === organizationId)
      .map((team) => [team.id, team.name]),
  );
  const userEmail = new Map(users.map((user) => [user.id, user.email]));
  return catalogs
    .map((catalog) => {
      const own = grants.get(catalog.id) ?? [];
      const of = (type: string) =>
        own.flatMap((grant) =>
          grant.subject.type === type ? [grant.subject.id] : [],
        );
      return {
        name: catalog.name,
        path: serverRulesPath(slugifyMcpServerName(catalog.name)),
        teams: of("team").flatMap((id) => {
          const name = teamName.get(id);
          return name ? [name] : [];
        }),
        roles: [...of("role"), ...of("organization")],
        users: of("user").flatMap((id) => {
          const email = userEmail.get(id);
          return email ? [{ id, email }] : [];
        }),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** GitHub logins by GitHub user id, for a day: they rarely change. */
const logins = new LRUCacheManager<string>({
  maxSize: 4096,
  defaultTtl: 24 * 60 * 60_000,
});

/**
 * The GitHub login of each user who connected a github.com account in
 * Archestra, by user id. Only github.com: the accounts Archestra holds are
 * github.com's, so a repository on another host gets none.
 */
async function connectedLogins(params: {
  organizationId: string;
  api: string;
  token: string;
  users: Array<{ id: string; email: string }>;
}): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (params.users.length === 0 || params.api !== "https://api.github.com")
    return found;
  // The roster names one person per GitHub account, by email.
  const byEmail = new Map(
    [
      ...(await RuntimeCredentialConnectionModel.listGitHubRoster(
        params.organizationId,
      )),
    ].map(([githubId, email]) => [email.toLowerCase(), String(githubId)]),
  );
  const users = [
    ...new Map(params.users.map((user) => [user.id, user])).values(),
  ];
  await mapWithConcurrency(users, 4, async ({ id: userId, email }) => {
    const githubId = byEmail.get(email.toLowerCase());
    if (!githubId) return;
    let login = logins.get(githubId);
    if (login === undefined) {
      const user = await githubCall<{ login?: string }>({
        token: params.token,
        url: `${params.api}/user/${encodeURIComponent(githubId)}`,
      });
      if (!user.ok || typeof user.body.login !== "string") return;
      login = user.body.login;
      logins.set(githubId, login);
    }
    found.set(userId, login);
  });
  return found;
}

/** The CODEOWNERS file GitHub reads at the accepted commit, if any. */
async function currentCodeOwners(
  source: ConnectedSource,
): Promise<{ path: string; content: string } | null> {
  const files = await openappaRepositoryIncludes.read({
    // CODEOWNERS paths are the repository's own, not appa.toml's folder's.
    source: { ...source, path: null },
    commit: source.sourceCommit,
    paths: CODEOWNERS_PATHS,
  });
  for (const path of CODEOWNERS_PATHS) {
    const content = files.get(path);
    if (content !== undefined) return { path, content };
  }
  return null;
}

/** CODEOWNERS with Archestra's block replaced, or appended once there are lines. */
function withOwnersBlock(
  current: string | null,
  lines: string[],
): string | null {
  const block = [
    OWNERS_BEGIN,
    `# Written from who may edit each MCP server in Archestra and ${OWNERS_MAP_FILE}.`,
    "# Change those, not these lines: Archestra rewrites them.",
    ...lines,
    OWNERS_END,
  ].join("\n");
  const start = current?.indexOf(OWNERS_BEGIN) ?? -1;
  const end = current && start >= 0 ? current.indexOf(OWNERS_END, start) : -1;
  if (current !== null && start >= 0 && end > start)
    return `${current.slice(0, start)}${block}${current.slice(end + OWNERS_END.length)}`;
  if (lines.length === 0) return current;
  return current === null || current.trim() === ""
    ? `${block}\n`
    : `${current.replace(/\n*$/, "\n\n")}${block}\n`;
}

async function openOwnersPull(params: {
  token: string;
  base: string;
  repo: string;
}): Promise<{ number: number; url: string; head: string } | null> {
  const owner = params.repo.slice(0, params.repo.indexOf("/"));
  const pulls = await githubCall<
    Array<{ number?: number; html_url?: string; head?: { sha?: string } }>
  >({
    token: params.token,
    url: `${params.base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${OWNERS_BRANCH}`)}`,
  });
  if (!pulls.ok) throw new ApiError(502, `GitHub answered ${pulls.status}`);
  const pull = pulls.body[0];
  return pull?.number && pull.html_url && pull.head?.sha
    ? {
        number: pull.number,
        url: pull.html_url,
        head: commitSha(pull.head.sha),
      }
    : null;
}

async function closeOwnersPull(params: {
  token: string;
  base: string;
  number: number;
}) {
  await githubCall({
    token: params.token,
    url: `${params.base}/pulls/${params.number}`,
    method: "PATCH",
    body: { state: "closed" },
  });
  await githubCall({
    token: params.token,
    url: `${params.base}/git/refs/heads/${OWNERS_BRANCH}`,
    method: "DELETE",
  });
}

/**
 * Commit the CODEOWNERS file on Archestra's branch, based on the accepted
 * commit, and open or update its one pull request. GitHub's own reading of
 * the file on that branch goes into the description, so its reviewers see an
 * owner GitHub does not know before merging.
 */
async function proposeOwners(params: {
  source: ConnectedSource;
  token: string;
  base: string;
  file: string;
  content: string | null;
  open: { number: number; url: string } | null;
  lines: string[];
  unowned: RepositoryProtection["codeOwners"]["unowned"];
  mapErrors: string[];
}): Promise<{ url: string }> {
  const { source, token, base } = params;
  const commit = await githubJson<{ tree?: { sha?: string } }>({
    token,
    url: `${base}/git/commits/${source.sourceCommit}`,
  });
  const tree = await githubJson<{ sha: string }>({
    token,
    url: `${base}/git/trees`,
    method: "POST",
    body: {
      base_tree: commitSha(commit.tree?.sha),
      tree: [
        {
          path: params.file,
          mode: "100644",
          type: "blob",
          content: params.content ?? "",
        },
      ],
    },
  });
  const created = await githubJson<{ sha: string }>({
    token,
    url: `${base}/git/commits`,
    method: "POST",
    body: {
      message: "Code owners for MCP server rules files",
      tree: commitSha(tree.sha),
      parents: [source.sourceCommit],
    },
  });
  const ref = await githubCall({
    token,
    url: `${base}/git/ref/heads/${OWNERS_BRANCH}`,
  });
  const moved = ref.ok
    ? await githubCall({
        token,
        url: `${base}/git/refs/heads/${OWNERS_BRANCH}`,
        method: "PATCH",
        body: { sha: commitSha(created.sha), force: true },
      })
    : await githubCall({
        token,
        url: `${base}/git/refs`,
        method: "POST",
        body: {
          ref: `refs/heads/${OWNERS_BRANCH}`,
          sha: commitSha(created.sha),
        },
      });
  if (!moved.ok)
    throw new ApiError(
      502,
      `GitHub answered ${moved.status} for the code owners branch`,
    );
  const errors = await githubCall<{
    errors?: Array<{ line?: number; kind?: string; message?: string }>;
  }>({
    token,
    url: `${base}/codeowners/errors?ref=${encodeURIComponent(OWNERS_BRANCH)}`,
  });
  const body = ownersPullBody({
    ...params,
    githubErrors: errors.ok ? (errors.body.errors ?? []) : [],
  });
  const title = "Code owners for MCP server rules files";
  if (params.open) {
    await githubJson({
      token,
      url: `${base}/pulls/${params.open.number}`,
      method: "PATCH",
      body: { title, body },
    });
    return { url: params.open.url };
  }
  const branch = source.ref ?? (await defaultBranch({ token, base }));
  const pull = await githubJson<{ html_url: string }>({
    token,
    url: `${base}/pulls`,
    method: "POST",
    body: { title, body, head: OWNERS_BRANCH, base: branch },
  });
  return { url: pull.html_url };
}

function ownersPullBody(params: {
  file: string;
  lines: string[];
  unowned: RepositoryProtection["codeOwners"]["unowned"];
  mapErrors: string[];
  githubErrors: Array<{ line?: number; kind?: string; message?: string }>;
}): string {
  const sections = [
    `Archestra keeps the block between \`${OWNERS_BEGIN}\` and \`${OWNERS_END}\` in \`${params.file}\` in line with who may edit each MCP server in its registry. Each server's rules file gets its editors as owners: teams and roles through \`${OWNERS_MAP_FILE}\`, people through the GitHub account they connected in Archestra or \`${OWNERS_MAP_FILE}\`. Merging this pull request applies it; until then, the owners above the block review each file.`,
    params.lines.length > 0
      ? `### Owners\n\n${params.lines.map((line) => `- \`${line}\``).join("\n")}`
      : "### Owners\n\nNo server's editors have a GitHub owner yet.",
  ];
  if (params.unowned.length > 0)
    sections.push(
      `### Editors without a GitHub owner\n\nAdd them to \`${OWNERS_MAP_FILE}\`, or ask them to connect GitHub in Archestra:\n\n${params.unowned.map((entry) => `- ${entry.server}: ${entry.editors.join(", ")}`).join("\n")}`,
    );
  if (params.mapErrors.length > 0)
    sections.push(
      `### Problems in ${OWNERS_MAP_FILE}\n\n${params.mapErrors.map((error) => `- ${error}`).join("\n")}`,
    );
  if (params.githubErrors.length > 0)
    sections.push(
      `### GitHub's reading of this file\n\nGitHub ignores these lines until they are fixed, for example by giving the team write access to the repository:\n\n${params.githubErrors.map((error) => `- line ${error.line ?? "?"}: ${error.message ?? error.kind ?? "unknown problem"}`).join("\n")}`,
    );
  return sections.join("\n\n");
}

// === GitHub calls ===

async function defaultBranch(params: { token: string; base: string }) {
  return (
    await githubJson<{ default_branch: string }>({
      token: params.token,
      url: params.base,
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
    response = await fetch(params.url, {
      method: params.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${params.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(params.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(params.body ? { body: JSON.stringify(params.body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
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

/** A commit or tree id GitHub returned, checked before it is used. */
function commitSha(sha: unknown): string {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha))
    throw new ApiError(502, "GitHub returned an invalid object");
  return sha;
}
