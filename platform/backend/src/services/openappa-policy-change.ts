import { createHash, randomUUID } from "node:crypto";
import { userHasPermission } from "@/auth";
import logger from "@/logging";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import UserModel from "@/models/user";
import { declaredCredentials } from "@/openappa/battery-target";
import {
  addedGrants,
  openappaDeclarations,
  type PolicyResolution,
} from "@/openappa/declarations";
import { withRequester } from "@/openappa/policy-text";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import {
  guardrailsPolicyService,
  requireGrantPermission,
} from "@/services/guardrails-policy";
import { resolveProposedPolicy } from "@/services/guardrails-policy-proposal";
import {
  type GithubErrorPolicy,
  githubFetch,
  githubJson,
  githubPolicyChangeErrors,
} from "@/services/openappa-github";
import {
  resolveOpenAppaGithubAccess,
  resolveOpenAppaGitlabAccess,
} from "@/services/openappa-github-access";
import { openappaGitlab } from "@/services/openappa-gitlab";
import { getOpenAppaPolicyTests } from "@/services/openappa-policy-tests";
import { ApiError } from "@/types";
import type { GuardrailsPolicyProposal } from "@/types/guardrails-policy-proposal";
import {
  PolicyTestDirectorySchema,
  PolicyTestFilesSchema,
} from "@/types/openappa-policy-tests";
import { PublicationUncertainError } from "@/types/openappa-publication";

type ChangeRequest = GuardrailsPolicyProposal & {
  organizationId: string;
  userId: string;
  expectedRevision: number;
  title: string;
  summary: string;
  includePolicy?: boolean;
  validationChanges?: {
    upsert: { path: string; content: string }[];
    delete: string[];
    directory: string;
    expectedVersion: string;
  };
  /**
   * Names the change request's branch, so publishing again under the same key
   * returns the request already opened, or completes a branch left without
   * one, instead of opening a second. An unconfirmed create then throws
   * `PublicationUncertainError`. Without it every publish opens a new branch.
   */
  operationKey?: string;
};

/** What a keyed publish left behind, as `findPublicationByKey` finds it. */
export type PolicyPublication =
  | {
      delivery: "pull_request";
      url: string;
      number: number;
      state: "open" | "closed" | "merged";
    }
  | { delivery: "revision"; revision: number };

/**
 * Publish a policy change through the configured source of truth. GitHub sync
 * writes a reviewable PR; a locally managed policy saves a revision.
 */
export async function publishOpenAppaPolicyChange(params: ChangeRequest) {
  const keyed =
    params.operationKey === undefined
      ? undefined
      : {
          operationKey: params.operationKey,
          branch: keyedBranch({
            organizationId: params.organizationId,
            operationKey: params.operationKey,
          }),
        };
  const source = await OpenAppaGithubSyncModel.find(params.organizationId);
  const before = await guardrailsPolicyService.get(params.organizationId);
  const includePolicy = params.includePolicy ?? true;
  if (!includePolicy && !params.validationChanges)
    throw new ApiError(
      400,
      "A validations-only change requires validation changes",
    );
  if (before.revision !== params.expectedRevision)
    throw new ApiError(
      409,
      "The policy changed. Read it again before proposing changes.",
    );
  const content = resolveProposedPolicy({ current: before, proposal: params });
  // Revision 0 is an unsaved starter, even when its text needs no edits.
  if (
    !params.validationChanges &&
    before.content === content &&
    (before.revision > 0 || source?.interval)
  )
    throw new ApiError(400, "The proposed policy has no changes");
  await refuseCredentialLines({
    organizationId: params.organizationId,
    userId: params.userId,
    before: before.content,
    after: content,
  });

  if (!source?.interval) {
    if (params.validationChanges || !includePolicy)
      throw new ApiError(
        409,
        "Save local policy and validation changes together through the validation workflow",
      );
    const saved = await guardrailsPolicyService.update({
      organizationId: params.organizationId,
      userId: params.userId,
      content,
      expectedRevision: params.expectedRevision,
    });
    return {
      delivery: "revision" as const,
      revision: saved.revision,
      warnings: saved.warnings,
      before: before.content,
      after: saved.content,
    };
  }

  if (!includePolicy && content !== before.content)
    throw new ApiError(
      400,
      "A validations-only change must keep the current policy",
    );

  if (
    !source.repo ||
    !source.path ||
    !(source.githubAppConfigId || source.githubPatId || source.gitlabTokenId)
  )
    throw new ApiError(
      409,
      "Connect a Git credential and policy file before proposing changes.",
    );
  if (
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "credential",
      "read",
    ))
  )
    throw new ApiError(403, "GitHub credential read permission is required");

  const validation = await guardrailsPolicyService.validate(content, {
    organizationId: params.organizationId,
    userId: params.userId,
    previous: before.content,
  });
  if (!validation.valid) throw new ApiError(400, validation.errors.join("\n"));

  if (source.gitlabTokenId)
    return publishGitlabChange({
      params,
      source: { ...source, repo: source.repo, path: source.path },
      gitlabTokenId: source.gitlabTokenId,
      keyed,
      includePolicy,
      content,
      before: before.content,
      warnings: validation.warnings,
    });

  const { token, api, web } = await resolveWriteToken(source);
  const base = `${api}/repos/${source.repo}`;
  const repo = source.repo;
  const policyPath = source.path;
  const published = (pull: { number: number; url: string }) => ({
    delivery: "pull_request" as const,
    number: pull.number,
    url: pull.url,
    repo,
    path: policyPath,
    warnings: validation.warnings,
    before: before.content,
    after: content,
  });
  if (keyed) {
    const existing = await findGithubPull({
      base,
      web,
      repo,
      head: keyed.branch,
      token,
    });
    if (existing) return published(existing);
  }
  const branch =
    source.ref ??
    (
      await githubJson<{ default_branch: string }>({
        url: base,
        token,
        errors: githubPolicyChangeErrors,
      })
    ).default_branch;
  if (!branch || !/^[^\p{Cc}\s~^:?*[\\]+$/u.test(branch))
    throw new ApiError(409, "The configured GitHub branch is invalid");

  const branchData = await githubJson<{ commit: { sha: string } }>({
    url: `${base}/branches/${encodeURIComponent(branch)}`,
    token,
    errors: githubPolicyChangeErrors,
  });
  const baseSha = branchData.commit?.sha;
  if (!baseSha || !/^[a-f0-9]{40}$/.test(baseSha))
    throw new ApiError(502, "GitHub returned an invalid branch commit");
  if (!source.sourceCommit || source.sourceCommit !== baseSha)
    throw new ApiError(
      409,
      "GitHub has changed since the last policy sync. Sync the policy, then review the new revision.",
    );

  // The commit names the person who asked, in a trailer GitHub's signature
  // for the App covers; an author of its own would leave the commit unsigned.
  const requester = await UserModel.getById(params.userId);
  const message = requester
    ? withRequester(params.title, requester.email)
    : params.title;
  let head: string;
  if (params.validationChanges) {
    await assertValidationSource(params);
    const commit = await githubJson<{ tree: { sha: string } }>({
      url: `${base}/git/commits/${baseSha}`,
      token,
      errors: githubPolicyChangeErrors,
    });
    const baseTree = checkedSha(commit.tree?.sha);
    const changes = params.validationChanges;
    const paths = [
      ...changes.upsert.map((file) => file.path),
      ...changes.delete,
      ...(includePolicy ? [source.path] : []),
    ];
    await assertRegularGitPaths({ paths, base, baseTree, token });
    await assertPublishSource({ params, source });
    await assertBranchUnchanged({ base, branch, baseSha, token });
    const tree = await githubJson<{ sha: string }>({
      method: "POST",
      url: `${base}/git/trees`,
      token,
      errors: githubPolicyChangeErrors,
      body: {
        base_tree: baseTree,
        tree: [
          ...changes.upsert.map((file) => ({
            path: file.path,
            mode: "100644",
            type: "blob",
            content: file.content,
          })),
          ...changes.delete.map((path) => ({
            path,
            mode: "100644",
            type: "blob",
            sha: null,
          })),
          ...(includePolicy
            ? [
                {
                  path: source.path,
                  mode: "100644",
                  type: "blob",
                  content,
                },
              ]
            : []),
        ],
      },
    });
    const treeSha = checkedSha(tree.sha);
    const keyedHead = keyed?.branch;
    head = keyedHead ?? `archestra/openappa-${randomUUID()}`;
    // Git names a tree by its content, so a keyed branch an earlier or a
    // racing attempt left holds this change exactly when its one commit on
    // the base has this tree.
    const reused = async (name: string) => {
      const tip = await branchTip({ base, head: name, token });
      if (!tip) return false;
      const left = await keyedCommit({ base, head: name, tip, baseSha, token });
      if (left.tree !== treeSha) throw differentChange(name);
      return true;
    };
    if (!(keyedHead && (await reused(keyedHead)))) {
      const commitResult = await githubJson<{ sha: string }>({
        method: "POST",
        url: `${base}/git/commits`,
        token,
        errors: githubPolicyChangeErrors,
        body: {
          message,
          tree: treeSha,
          parents: [baseSha],
        },
      });
      const commitSha = checkedSha(commitResult.sha);
      await assertPublishSource({ params, source });
      await assertBranchUnchanged({ base, branch, baseSha, token });
      await githubJson({
        method: "POST",
        url: `${base}/git/refs`,
        token,
        errors: keyedHead ? keyedWriteErrors : githubPolicyChangeErrors,
        body: { ref: `refs/heads/${head}`, sha: commitSha },
      }).catch(async (error) => {
        if (
          keyedHead &&
          error instanceof KeyedWriteConflict &&
          (await reused(keyedHead))
        )
          return;
        throw error;
      });
    }
  } else {
    const path = source.path.split("/").map(encodeURIComponent).join("/");
    const file = await githubJson<{ sha: string }>({
      url: `${base}/contents/${path}?ref=${baseSha}`,
      token,
      errors: githubPolicyChangeErrors,
    });
    if (!file.sha || !/^[a-f0-9]{40}$/.test(file.sha))
      throw new ApiError(502, "GitHub returned an invalid policy file");

    await assertPublishSource({ params, source });
    await assertBranchUnchanged({ base, branch, baseSha, token });

    head = keyed?.branch ?? `archestra/openappa-${randomUUID()}`;
    const writeErrors = keyed ? keyedWriteErrors : githubPolicyChangeErrors;
    // A keyed branch an earlier attempt left still at the base lacks only
    // the commit; one past it must be that commit.
    const prepare = async () => {
      const tip = keyed ? await branchTip({ base, head, token }) : null;
      if (tip === null)
        await githubJson({
          method: "POST",
          url: `${base}/git/refs`,
          token,
          errors: writeErrors,
          body: { ref: `refs/heads/${head}`, sha: baseSha },
        });
      if (tip === null || tip === baseSha)
        await githubJson({
          method: "PUT",
          url: `${base}/contents/${path}`,
          token,
          errors: writeErrors,
          body: {
            message,
            content: Buffer.from(content).toString("base64"),
            sha: file.sha,
            branch: head,
          },
        });
      else
        await assertKeyedContents({
          base,
          head,
          tip,
          baseSha,
          token,
          path: policyPath,
          content,
        });
    };
    // A same-key publish racing this one won a write, the branch or then its
    // commit, so at most two are lost before what it left decides.
    for (let lost = 0; ; lost++) {
      try {
        await prepare();
        break;
      } catch (error) {
        if (!(error instanceof KeyedWriteConflict) || lost === 2) throw error;
      }
    }
  }
  const body = {
    title: params.title,
    body: params.summary,
    head,
    base: branch,
  };
  if (keyed)
    return published(
      await openKeyedPull({
        base,
        web,
        repo,
        token,
        body,
        operationKey: keyed.operationKey,
      }),
    );
  const pull = await githubJson<{ number: number; html_url: string }>({
    method: "POST",
    url: `${base}/pulls`,
    token,
    errors: githubPolicyChangeErrors,
    body,
  });
  const url = checkedPullUrl({
    url: pull.html_url,
    web,
    repo,
    number: pull.number,
  });
  return published({ number: pull.number, url });
}

/**
 * @public — the tuner apply flow's reconcile step consumes it.
 *
 * What a keyed publish left, for a caller that did not see its outcome: the
 * pull or merge request from the key's branch in the Git source's repository,
 * else the local revision right after `local.expectedRevision` when it holds
 * the content whose hash (sha256 hex, as revisions store it) is
 * `local.contentHash`. Null only when neither exists. A Git host that cannot
 * be asked throws, and so does a source no longer connected to `repo`, the
 * repository the publish was sent to when the caller recorded it: the request
 * may be there, out of reach.
 */
export async function findPublicationByKey(params: {
  organizationId: string;
  operationKey: string;
  repo?: string;
  local?: { expectedRevision: number; contentHash: string };
}): Promise<PolicyPublication | null> {
  const head = keyedBranch(params);
  const source = await OpenAppaGithubSyncModel.find(params.organizationId);
  const connected =
    source?.repo &&
    (source.gitlabTokenId || source.githubAppConfigId || source.githubPatId);
  if (params.repo !== undefined && (!connected || source.repo !== params.repo))
    throw new ApiError(
      409,
      "The Git source changed since the change was published, so whether its request opened cannot be checked",
    );
  if (connected && source.repo) {
    const repo = source.repo;
    let found: Omit<
      Extract<PolicyPublication, { delivery: "pull_request" }>,
      "delivery"
    > | null;
    if (source.gitlabTokenId) {
      const request = await openappaGitlab.requestForBranch({
        access: await resolveOpenAppaGitlabAccess({
          organizationId: params.organizationId,
          gitlabTokenId: source.gitlabTokenId,
        }),
        repo,
        branch: head,
      });
      found = request && {
        number: request.iid,
        url: request.webUrl,
        state: request.state,
      };
    } else {
      const { token, api, web } = await resolveWriteToken(source);
      found = await findGithubPull({
        base: `${api}/repos/${repo}`,
        web,
        repo,
        head,
        token,
      });
    }
    if (found) return { delivery: "pull_request", ...found };
  }
  if (!params.local) return null;
  const saved = await GuardrailsPolicyModel.findRevision({
    organizationId: params.organizationId,
    revision: params.local.expectedRevision + 1,
  });
  return saved?.contentHash === params.local.contentHash
    ? { delivery: "revision", revision: saved.revision }
    : null;
}

export async function getOpenAppaPolicyChangeStatus(params: {
  organizationId: string;
  userId: string;
  number: number;
}) {
  const source = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (
    !source?.interval ||
    !source.repo ||
    !(source.githubAppConfigId || source.githubPatId || source.gitlabTokenId)
  )
    throw new ApiError(409, "Git sync with a credential is not configured");
  if (
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "credential",
      "read",
    ))
  )
    throw new ApiError(403, "GitHub credential read permission is required");
  const repo = source.repo;
  if (source.gitlabTokenId) {
    const access = await resolveOpenAppaGitlabAccess({
      organizationId: params.organizationId,
      gitlabTokenId: source.gitlabTokenId,
    });
    const request = await openappaGitlab.changeStatus({
      access,
      repo,
      iid: params.number,
    });
    return {
      number: request.iid,
      url: request.webUrl,
      state: request.state,
      mergeable: request.mergeable,
      ...(request.state === "merged"
        ? await mergedChangeSync({
            organizationId: params.organizationId,
            source,
            mergeCommit: request.mergeCommitSha,
            mergedAt: request.mergedAt,
            contains: (commit, ancestor) =>
              openappaGitlab.contains({ access, repo, commit, ancestor }),
          })
        : {}),
      sync: {
        sourceCommit: source.sourceCommit,
        lastSyncedAt: source.lastSyncedAt,
        lastSyncError: source.lastSyncError,
      },
    };
  }
  const { token, api, web } = await resolveWriteToken(source);
  const pull = await githubJson<{
    number: number;
    html_url: string;
    state: "open" | "closed";
    merged: boolean;
    merged_at?: string | null;
    merge_commit_sha?: string | null;
    mergeable: boolean | null;
    head: { ref: string };
  }>({
    url: `${api}/repos/${repo}/pulls/${params.number}`,
    token,
    errors: githubPolicyChangeErrors,
  });
  if (!pull.head?.ref?.startsWith("archestra/openappa-"))
    throw new ApiError(404, "OpenAPPA policy pull request not found");
  return {
    number: pull.number,
    url: checkedPullUrl({
      url: pull.html_url,
      web,
      repo,
      number: pull.number,
    }),
    state: pull.merged ? "merged" : pull.state,
    mergeable: pull.mergeable,
    ...(pull.merged
      ? await mergedChangeSync({
          organizationId: params.organizationId,
          source,
          mergeCommit: pull.merge_commit_sha ?? null,
          mergedAt: pull.merged_at ?? null,
          contains: async (commit, ancestor) =>
            commit === ancestor ||
            ["ahead", "identical"].includes(
              (
                await githubJson<{ status?: string }>({
                  url: `${api}/repos/${repo}/compare/${ancestor}...${commit}`,
                  token,
                  errors: githubPolicyChangeErrors,
                })
              ).status ?? "",
            ),
        })
      : {}),
    sync: {
      sourceCommit: source.sourceCommit,
      lastSyncedAt: source.lastSyncedAt,
      lastSyncError: source.lastSyncError,
    },
  };
}

/**
 * Whether Git sync applied a merged change: the accepted commit contains its
 * merge. Until it does, a pull is queued rather than left to the schedule,
 * unless a pull since the merge failed: nothing applies until that is put
 * right, so the failure is the answer.
 */
async function mergedChangeSync(params: {
  organizationId: string;
  source: {
    sourceCommit: string | null;
    lastSyncedAt: Date | null;
    lastSyncError: string | null;
  };
  /** The commit the merge left on the branch; null when the host gives none. */
  mergeCommit: string | null;
  mergedAt: string | null;
  contains: (commit: string, ancestor: string) => Promise<boolean>;
}): Promise<{
  applied: boolean;
  syncQueued?: boolean;
  syncFailed?: { reason: string };
  instruction: string;
}> {
  const { source } = params;
  if (
    source.sourceCommit &&
    params.mergeCommit &&
    (await params.contains(source.sourceCommit, params.mergeCommit))
  )
    return {
      applied: true,
      instruction:
        "Git sync applied the merged change: the policy it carries is the one in force.",
    };
  const mergedAt = params.mergedAt ? Date.parse(params.mergedAt) : Number.NaN;
  if (
    source.lastSyncError &&
    source.lastSyncedAt &&
    (Number.isNaN(mergedAt) || source.lastSyncedAt.getTime() > mergedAt)
  )
    return {
      applied: false,
      syncFailed: { reason: source.lastSyncError },
      instruction:
        "The change merged, but Git sync failed since: say why, from syncFailed.reason. The merged policy is not in force until that is fixed.",
    };
  await OpenAppaGithubSyncModel.enqueue(params.organizationId);
  return {
    applied: false,
    syncQueued: true,
    instruction:
      "The change merged and Git sync is applying it now. Check again in a minute before you say it is in force.",
  };
}

/**
 * The agent path binds battery credentials with bind_guardrails_credential. A
 * `[credentials]` line wins over that binding and locks it in the Batteries
 * dialog, so an agent may not add a line, or change its key, for a variable an
 * included battery reads. Removing a line is allowed. A credential a root
 * external or profile reads as its `token_env` has no stored binding, so adding
 * or rekeying it, or pointing another reader at it, takes `credential:update`
 * as it does on the Policy route.
 */
export async function refuseCredentialLines(params: {
  organizationId: string;
  userId: string;
  before: string;
  after: string;
}): Promise<void> {
  const [previous, submitted] = await Promise.all(
    [params.before, params.after].map((content) =>
      openappaDeclarations.resolveWithBindings({
        organizationId: params.organizationId,
        content,
      }),
    ),
  );
  const before = textLines(previous);
  const written = [
    ...batteryLines(submitted.resolution.entries, textLines(submitted)),
  ]
    .filter(([variable, key]) => before[variable] !== key)
    .map(([variable]) => variable);
  if (written.length > 0)
    throw new ApiError(
      400,
      `Bind ${written.join(", ")} with bind_guardrails_credential instead of a [credentials] line; the policy text is for rules and includes.`,
    );
  await requireGrantPermission({
    organizationId: params.organizationId,
    userId: params.userId,
    granted: addedGrants(
      openappaDeclarations.rootGrants(previous.resolution),
      openappaDeclarations.rootGrants(submitted.resolution),
    ),
  });
}

function checkedPullUrl(params: {
  url: string;
  web: string;
  repo: string;
  number: number;
}) {
  const { url, number } = params;
  const expected = `${params.web}/${params.repo}/pull/${number}`;
  if (url !== expected || !Number.isSafeInteger(number) || number < 1)
    throw new ApiError(502, "GitHub returned an invalid pull request");
  return url;
}

async function assertPublishSource(params: {
  params: ChangeRequest;
  source: NonNullable<Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>>;
}) {
  const [current, policy, suite] = await Promise.all([
    OpenAppaGithubSyncModel.find(params.params.organizationId),
    guardrailsPolicyService.get(params.params.organizationId),
    params.params.validationChanges
      ? OpenAppaPolicyTestsModel.find(params.params.organizationId)
      : Promise.resolve(null),
  ]);
  if (
    !current?.interval ||
    current.revision !== params.source.revision ||
    current.sourceCommit !== params.source.sourceCommit ||
    current.repo !== params.source.repo ||
    current.ref !== params.source.ref ||
    current.path !== params.source.path ||
    current.githubAppConfigId !== params.source.githubAppConfigId ||
    current.githubPatId !== params.source.githubPatId ||
    current.gitlabTokenId !== params.source.gitlabTokenId ||
    policy.revision !== params.params.expectedRevision ||
    (params.params.validationChanges &&
      ((suite?.directory ?? "traces") !==
        params.params.validationChanges.directory ||
        suite?.sourceCommit !== params.source.sourceCommit))
  )
    throw new ApiError(
      409,
      "The policy or GitHub source changed. Read it again before proposing changes.",
    );
}

/**
 * The GitLab write path: one commit on a new branch from the synced commit,
 * then a merge request. The same freshness checks as GitHub guard it, and
 * GitLab's `start_sha` refuses the commit if the branch moved meanwhile.
 */
async function publishGitlabChange(args: {
  params: ChangeRequest;
  source: NonNullable<
    Awaited<ReturnType<typeof OpenAppaGithubSyncModel.find>>
  > & { repo: string; path: string };
  gitlabTokenId: string;
  keyed: { operationKey: string; branch: string } | undefined;
  includePolicy: boolean;
  content: string;
  before: string;
  warnings: string[];
}) {
  const { params, source } = args;
  const access = await resolveOpenAppaGitlabAccess({
    organizationId: params.organizationId,
    gitlabTokenId: args.gitlabTokenId,
  });
  const published = (request: { iid: number; webUrl: string }) => ({
    delivery: "pull_request" as const,
    number: request.iid,
    url: request.webUrl,
    repo: source.repo,
    path: source.path,
    warnings: args.warnings,
    before: args.before,
    after: args.content,
  });
  if (args.keyed) {
    const existing = await openappaGitlab.requestForBranch({
      access,
      repo: source.repo,
      branch: args.keyed.branch,
    });
    if (existing) return published(existing);
  }
  const branch =
    source.ref ??
    (await openappaGitlab.defaultBranch({ access, repo: source.repo }));
  const baseSha = await openappaGitlab.branchCommit({
    access,
    repo: source.repo,
    branch,
  });
  if (!source.sourceCommit || source.sourceCommit !== baseSha)
    throw new ApiError(
      409,
      "GitLab has changed since the last policy sync. Sync the policy, then review the new revision.",
    );
  if (params.validationChanges) await assertValidationSource(params);
  await assertPublishSource({ params, source });
  const changes = params.validationChanges;
  const request = await openappaGitlab.proposeChange({
    access,
    repo: source.repo,
    branch,
    baseSha,
    title: params.title,
    summary: params.summary,
    upsert: [
      ...(changes?.upsert ?? []),
      ...(args.includePolicy
        ? [{ path: source.path, content: args.content }]
        : []),
    ],
    delete: changes?.delete ?? [],
    keyed: args.keyed,
  });
  return published(request);
}

async function resolveWriteToken(source: {
  organizationId: string;
  githubPatId: string | null;
  githubAppConfigId: string | null;
  repo: string | null;
}) {
  if (!source.githubPatId && !source.githubAppConfigId)
    throw new ApiError(409, "A GitHub write credential is required");
  const access = await resolveOpenAppaGithubAccess(source, {
    contents: "write",
    pull_requests: "write",
  });
  return { ...access, token: access.token as string };
}

async function assertValidationSource(params: ChangeRequest) {
  const changes = params.validationChanges;
  if (!changes) return;
  if (!PolicyTestDirectorySchema.safeParse(changes.directory).success)
    throw new ApiError(
      400,
      "Use a configured repository-relative validation directory",
    );
  if (
    !PolicyTestFilesSchema.safeParse(changes.upsert).success ||
    changes.delete.length > 32
  )
    throw new ApiError(
      400,
      "The validation changes exceed the collection limits or contain invalid files",
    );
  const paths = [...changes.upsert.map((file) => file.path), ...changes.delete];
  const source = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (
    new Set(paths).size !== paths.length ||
    paths.some(
      (path) =>
        !PolicyTestDirectorySchema.safeParse(path).success ||
        !path.endsWith(".appa") ||
        !path.startsWith(`${changes.directory}/`) ||
        path.slice(changes.directory.length + 1).includes("/") ||
        path === source?.path,
    )
  )
    throw new ApiError(
      400,
      "Change only distinct .appa files directly inside the configured validation directory",
    );
  const collection = await getOpenAppaPolicyTests(
    params.organizationId,
    params.userId,
  );
  if (
    collection.source !== "github" ||
    collection.error ||
    !collection.activeDirectory ||
    collection.activeDirectory !== changes.directory ||
    collection.directory !== changes.directory ||
    collection.sourceCommit !== source?.sourceCommit ||
    collection.version !== changes.expectedVersion
  )
    throw new ApiError(
      409,
      "The GitHub validations changed or are unavailable. Read them again before proposing changes.",
    );
  const current = new Map(collection.files.map((file) => [file.path, file]));
  if (changes.delete.some((path) => !current.has(path)))
    throw new ApiError(
      409,
      "A validation selected for deletion no longer exists",
    );
  for (const path of changes.delete) current.delete(path);
  for (const file of changes.upsert) current.set(file.path, file);
  if (!PolicyTestFilesSchema.safeParse([...current.values()]).success)
    throw new ApiError(
      400,
      "The resulting validation collection exceeds the collection limits",
    );
  if (
    !(params.includePolicy ?? true) &&
    changes.delete.length === 0 &&
    changes.upsert.every(
      (file) =>
        collection.files.find((existing) => existing.path === file.path)
          ?.content === file.content,
    )
  )
    throw new ApiError(400, "The proposed validations have no changes");
}

async function assertBranchUnchanged(params: {
  base: string;
  branch: string;
  baseSha: string;
  token: string;
}) {
  const branch = await githubJson<{ commit: { sha: string } }>({
    url: `${params.base}/branches/${encodeURIComponent(params.branch)}`,
    token: params.token,
    errors: githubPolicyChangeErrors,
  });
  if (branch.commit?.sha !== params.baseSha)
    throw new ApiError(
      409,
      "GitHub has changed since the last policy sync. Sync and review the new revision.",
    );
}

/**
 * The branch an operation key names: a digest, so any key makes a valid ref
 * that no other key or organization shares, under the prefix the status
 * check accepts.
 */
function keyedBranch(params: {
  organizationId: string;
  operationKey: string;
}): string {
  if (!params.operationKey)
    throw new ApiError(400, "An operation key must not be empty");
  const digest = createHash("sha256")
    .update(`${params.organizationId}\n${params.operationKey}`)
    .digest("hex");
  return `archestra/openappa-op-${digest.slice(0, 40)}`;
}

type GithubPull = { number: number; url: string };

/** The pull request from `head` in any state, an open one first; null when none. */
async function findGithubPull(params: {
  base: string;
  web: string;
  repo: string;
  head: string;
  token: string;
}): Promise<(GithubPull & { state: "open" | "closed" | "merged" }) | null> {
  const owner = params.repo.split("/")[0];
  const pulls = await githubJson<
    {
      number: number;
      html_url: string;
      state: string;
      merged_at?: string | null;
      head?: { ref?: string };
    }[]
  >({
    url: `${params.base}/pulls?head=${encodeURIComponent(`${owner}:${params.head}`)}&state=all&per_page=100`,
    token: params.token,
    errors: githubPolicyChangeErrors,
  });
  if (!Array.isArray(pulls))
    throw new ApiError(502, "GitHub returned an invalid pull request list");
  const pull = pulls
    .filter((entry) => entry.head?.ref === params.head)
    .sort((a, b) => Number(b.state === "open") - Number(a.state === "open"))[0];
  if (!pull) return null;
  return {
    number: pull.number,
    url: checkedPullUrl({
      url: pull.html_url,
      web: params.web,
      repo: params.repo,
      number: pull.number,
    }),
    state: pull.merged_at
      ? "merged"
      : pull.state === "open"
        ? "open"
        : "closed",
  };
}

/**
 * Open the pull request for a keyed branch. A create GitHub refused with an
 * answer fails as usual; one it did not answer, or answered with a server
 * fault or an existing request (422), is decided by the request found from
 * the branch, or is uncertain.
 */
async function openKeyedPull(params: {
  base: string;
  web: string;
  repo: string;
  token: string;
  body: { title: string; body: string; head: string; base: string };
  operationKey: string;
}): Promise<GithubPull> {
  let response: Response | undefined;
  try {
    response = await githubFetch({
      method: "POST",
      url: `${params.base}/pulls`,
      token: params.token,
      body: params.body,
    });
  } catch (err) {
    logger.warn({ err }, "OpenAPPA could not reach GitHub");
  }
  if (
    response &&
    response.status >= 400 &&
    response.status < 500 &&
    response.status !== 422
  )
    throw await githubPolicyChangeErrors(response);
  if (response?.ok) {
    try {
      const bytes = await readResponseBodyWithLimit(response, 2 * 1024 * 1024);
      const pull = JSON.parse(bytes?.toString() ?? "") as {
        number: number;
        html_url: string;
      };
      return {
        number: pull.number,
        url: checkedPullUrl({
          url: pull.html_url,
          web: params.web,
          repo: params.repo,
          number: pull.number,
        }),
      };
    } catch {
      // Created, but unreadable: the branch's request is the answer.
    }
  }
  const found = await findGithubPull({
    ...params,
    head: params.body.head,
  }).catch((err) => {
    logger.warn({ err }, "OpenAPPA could not look for a policy pull request");
    return undefined;
  });
  if (found) return found;
  if (response?.status === 422 && found === null)
    throw await githubPolicyChangeErrors(response);
  throw new PublicationUncertainError(params.operationKey);
}

/** The commit a branch points at, or null when it does not exist. */
async function branchTip(params: {
  base: string;
  head: string;
  token: string;
}): Promise<string | null> {
  try {
    const branch = await githubJson<{ commit: { sha: string } }>({
      url: `${params.base}/branches/${encodeURIComponent(params.head)}`,
      token: params.token,
      errors: githubPolicyChangeErrors,
    });
    return checkedSha(branch.commit?.sha);
  } catch (error) {
    if (error instanceof ApiError && error.statusCode === 404) return null;
    throw error;
  }
}

/** The tree of a keyed branch's commit, which must be one commit on `baseSha`. */
async function keyedCommit(params: {
  base: string;
  head: string;
  tip: string;
  baseSha: string;
  token: string;
}): Promise<{ tree: string }> {
  const commit = await githubJson<{
    tree?: { sha?: string };
    parents?: { sha?: string }[];
  }>({
    url: `${params.base}/git/commits/${params.tip}`,
    token: params.token,
    errors: githubPolicyChangeErrors,
  });
  if (commit.parents?.length !== 1 || commit.parents[0]?.sha !== params.baseSha)
    throw differentChange(params.head);
  return { tree: checkedSha(commit.tree?.sha) };
}

/**
 * A keyed branch's one commit on the base must change exactly the policy
 * file, to this content.
 */
async function assertKeyedContents(params: {
  base: string;
  head: string;
  tip: string;
  baseSha: string;
  token: string;
  path: string;
  content: string;
}) {
  await keyedCommit(params);
  const compare = await githubJson<{
    files?: { filename?: string; status?: string; sha?: string }[];
  }>({
    url: `${params.base}/compare/${params.baseSha}...${params.tip}`,
    token: params.token,
    errors: githubPolicyChangeErrors,
  });
  const [file, ...more] = compare.files ?? [];
  if (
    more.length > 0 ||
    file?.filename !== params.path ||
    file.status !== "modified" ||
    file.sha !== gitBlobSha(params.content)
  )
    throw differentChange(params.head);
}

/** A keyed write GitHub refused as already done: a racing attempt made it. */
class KeyedWriteConflict extends ApiError {}

const keyedWriteErrors: GithubErrorPolicy = async (response) =>
  response.status === 409 || response.status === 422
    ? new KeyedWriteConflict(
        409,
        "GitHub refused a write to the change's branch as conflicting",
      )
    : githubPolicyChangeErrors(response);

function differentChange(head: string) {
  return new ApiError(
    409,
    `The branch ${head} already holds a different change`,
  );
}

/** The object name Git gives `content` as a file. */
function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content);
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

function checkedSha(sha: unknown): string {
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha))
    throw new ApiError(502, "GitHub returned an invalid Git object");
  return sha;
}

async function assertRegularGitPaths(params: {
  paths: string[];
  base: string;
  baseTree: string;
  token: string;
}) {
  const cache = new Map<
    string,
    { path: string; mode: string; type: string; sha: string }[]
  >();
  for (const path of params.paths) {
    const segments = path.split("/");
    let treeSha = params.baseTree;
    for (const [index, segment] of segments.entries()) {
      let entries = cache.get(treeSha);
      if (!entries) {
        const result = await githubJson<{
          truncated: boolean;
          tree: { path: string; mode: string; type: string; sha: string }[];
        }>({
          url: `${params.base}/git/trees/${treeSha}`,
          token: params.token,
          errors: githubPolicyChangeErrors,
        });
        if (result.truncated || !Array.isArray(result.tree))
          throw new ApiError(
            502,
            "GitHub returned an incomplete repository tree",
          );
        entries = result.tree;
        cache.set(treeSha, entries);
      }
      const entry = entries.find((item) => item.path === segment);
      if (index < segments.length - 1) {
        if (!entry || entry.type !== "tree" || entry.mode !== "040000")
          throw new ApiError(
            409,
            "The policy or validation directory must be a regular Git directory",
          );
        treeSha = checkedSha(entry.sha);
      } else if (
        entry &&
        (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
      ) {
        throw new ApiError(
          409,
          "Policy and validation changes cannot replace symlinks, directories or submodules",
        );
      }
    }
  }
}

function batteryLines(
  entries: PolicyResolution["entries"],
  credentials: Record<string, string>,
): Map<string, string> {
  const read = new Set(
    entries.flatMap((entry) =>
      entry.battery ? declaredCredentials(entry.battery) : [],
    ),
  );
  return new Map(
    Object.entries(credentials).filter(([variable]) => read.has(variable)),
  );
}

/** The `[credentials]` lines the text itself spells, without stored bindings. */
function textLines(
  bound: Awaited<ReturnType<typeof openappaDeclarations.resolveWithBindings>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(bound.resolution.credentials).filter(
      ([variable]) => bound.credentialSource[variable] === "policy",
    ),
  );
}
