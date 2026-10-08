import { randomUUID } from "node:crypto";
import { userHasPermission } from "@/auth";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { openappaDeclarations } from "@/openappa/declarations";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { resolveProposedPolicy } from "@/services/guardrails-policy-proposal";
import { getOpenAppaPolicyTests } from "@/services/openappa-policy-tests";
import {
  resolveGithubAppInstallationToken,
  resolveGithubPatToken,
} from "@/skills/github-app-token";
import { ApiError } from "@/types";
import type { GuardrailsPolicyProposal } from "@/types/guardrails-policy-proposal";
import {
  PolicyTestDirectorySchema,
  PolicyTestFilesSchema,
} from "@/types/openappa-policy-tests";

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
};

/**
 * Publish a policy change through the configured source of truth. GitHub sync
 * writes a reviewable PR; a locally managed policy saves a revision.
 */
export async function publishOpenAppaPolicyChange(params: ChangeRequest) {
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
    !(source.githubAppConfigId || source.githubPatId)
  )
    throw new ApiError(
      409,
      "Connect a GitHub credential and policy file before proposing changes.",
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
    previous: before.content,
  });
  if (!validation.valid) throw new ApiError(400, validation.errors.join("\n"));

  const token = await resolveWriteToken(source);
  const base = `/repos/${source.repo}`;
  const branch =
    source.ref ??
    (
      await githubJson<{ default_branch: string }>({
        path: base,
        token,
      })
    ).default_branch;
  if (!branch || !/^[^\p{Cc}\s~^:?*[\\]+$/u.test(branch))
    throw new ApiError(409, "The configured GitHub branch is invalid");

  const branchData = await githubJson<{ commit: { sha: string } }>({
    path: `${base}/branches/${encodeURIComponent(branch)}`,
    token,
  });
  const baseSha = branchData.commit?.sha;
  if (!baseSha || !/^[a-f0-9]{40}$/.test(baseSha))
    throw new ApiError(502, "GitHub returned an invalid branch commit");
  if (!source.sourceCommit || source.sourceCommit !== baseSha)
    throw new ApiError(
      409,
      "GitHub has changed since the last policy sync. Sync the policy, then review the new revision.",
    );

  let head: string;
  if (params.validationChanges) {
    await assertValidationSource(params);
    const commit = await githubJson<{ tree: { sha: string } }>({
      path: `${base}/git/commits/${baseSha}`,
      token,
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
      path: `${base}/git/trees`,
      token,
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
    const commitResult = await githubJson<{ sha: string }>({
      method: "POST",
      path: `${base}/git/commits`,
      token,
      body: {
        message: params.title,
        tree: checkedSha(tree.sha),
        parents: [baseSha],
      },
    });
    const commitSha = checkedSha(commitResult.sha);
    await assertPublishSource({ params, source });
    await assertBranchUnchanged({ base, branch, baseSha, token });
    head = `archestra/openappa-${randomUUID()}`;
    await githubJson({
      method: "POST",
      path: `${base}/git/refs`,
      token,
      body: { ref: `refs/heads/${head}`, sha: commitSha },
    });
  } else {
    const path = source.path.split("/").map(encodeURIComponent).join("/");
    const file = await githubJson<{ sha: string }>({
      path: `${base}/contents/${path}?ref=${baseSha}`,
      token,
    });
    if (!file.sha || !/^[a-f0-9]{40}$/.test(file.sha))
      throw new ApiError(502, "GitHub returned an invalid policy file");

    await assertPublishSource({ params, source });
    await assertBranchUnchanged({ base, branch, baseSha, token });

    head = `archestra/openappa-${randomUUID()}`;
    await githubJson({
      method: "POST",
      path: `${base}/git/refs`,
      token,
      body: { ref: `refs/heads/${head}`, sha: baseSha },
    });
    await githubJson({
      method: "PUT",
      path: `${base}/contents/${path}`,
      token,
      body: {
        message: params.title,
        content: Buffer.from(content).toString("base64"),
        sha: file.sha,
        branch: head,
      },
    });
  }
  const pull = await githubJson<{ number: number; html_url: string }>({
    method: "POST",
    path: `${base}/pulls`,
    token,
    body: {
      title: params.title,
      body: params.summary,
      head,
      base: branch,
    },
  });
  const url = checkedPullUrl(pull.html_url, source.repo, pull.number);
  return {
    delivery: "pull_request" as const,
    number: pull.number,
    url,
    repo: source.repo,
    path: source.path,
    warnings: validation.warnings,
    before: before.content,
    after: content,
  };
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
    !(source.githubAppConfigId || source.githubPatId)
  )
    throw new ApiError(409, "GitHub sync with a credential is not configured");
  if (
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "credential",
      "read",
    ))
  )
    throw new ApiError(403, "GitHub credential read permission is required");
  const token = await resolveWriteToken(source);
  const pull = await githubJson<{
    number: number;
    html_url: string;
    state: "open" | "closed";
    merged: boolean;
    mergeable: boolean | null;
    head: { ref: string };
  }>({
    path: `/repos/${source.repo}/pulls/${params.number}`,
    token,
  });
  if (!pull.head?.ref?.startsWith("archestra/openappa-"))
    throw new ApiError(404, "OpenAPPA policy pull request not found");
  return {
    number: pull.number,
    url: checkedPullUrl(pull.html_url, source.repo, pull.number),
    state: pull.merged ? "merged" : pull.state,
    mergeable: pull.mergeable,
    sync: {
      sourceCommit: source.sourceCommit,
      lastSyncedAt: source.lastSyncedAt,
      lastSyncError: source.lastSyncError,
    },
  };
}

/**
 * The agent path binds battery credentials with bind_guardrails_credential. A
 * `[credentials]` line wins over that binding and locks it in the Batteries
 * dialog, so an agent may not add a line, or change its key, for a variable an
 * included battery reads. Removing a line is allowed. A variable only a root
 * external's `token_env` names has no stored binding, so its line stays writable.
 */
export async function refuseCredentialLines(params: {
  organizationId: string;
  before: string;
  after: string;
}): Promise<void> {
  const [previous, submitted] = await Promise.all([
    openappaDeclarations.resolve({
      organizationId: params.organizationId,
      content: params.before,
    }),
    batteryCredentialLines(params.organizationId, params.after),
  ]);
  const written = [...submitted]
    .filter(([variable, key]) => previous.credentials[variable] !== key)
    .map(([variable]) => variable);
  if (written.length > 0)
    throw new ApiError(
      400,
      `Bind ${written.join(", ")} with bind_guardrails_credential instead of a [credentials] line; the policy text is for rules and includes.`,
    );
}

/** The validation warning for `[credentials]` lines that override a stored binding. */
export async function credentialLineWarnings(
  organizationId: string,
  content: string,
): Promise<string[]> {
  const lines = await batteryCredentialLines(organizationId, content);
  if (lines.size === 0) return [];
  return [
    `[credentials] in the policy text overrides the stored binding for ${[...lines.keys()].join(", ")}. Prefer bind_guardrails_credential; a text line locks the key in the Batteries dialog.`,
  ];
}

async function githubJson<T = unknown>(params: {
  path: string;
  token: string;
  method?: "GET" | "POST" | "PUT";
  body?: object;
}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`https://api.github.com${params.path}`, {
      method: params.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${params.token}`,
        ...(params.body ? { "Content-Type": "application/json" } : {}),
      },
      redirect: "error",
      ...(params.body ? { body: JSON.stringify(params.body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(502, "Could not reach GitHub");
  }
  if (!response.ok)
    throw new ApiError(
      response.status === 404 ? 404 : 502,
      `GitHub returned HTTP ${response.status}. Check repository access and credential permissions. PR publishing needs Contents and Pull requests read/write.`,
    );
  const bytes = await readResponseBodyWithLimit(response, 2 * 1024 * 1024);
  if (!bytes) throw new ApiError(502, "GitHub response is too large");
  try {
    return JSON.parse(bytes.toString()) as T;
  } catch {
    throw new ApiError(502, "GitHub returned an invalid response");
  }
}

function checkedPullUrl(url: string, repo: string, number: number) {
  const expected = `https://github.com/${repo}/pull/${number}`;
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

async function resolveWriteToken(source: {
  organizationId: string;
  githubPatId: string | null;
  githubAppConfigId: string | null;
}) {
  if (source.githubPatId)
    return resolveGithubPatToken({
      organizationId: source.organizationId,
      githubPatId: source.githubPatId,
    });
  if (source.githubAppConfigId)
    return resolveGithubAppInstallationToken({
      organizationId: source.organizationId,
      githubAppConfigId: source.githubAppConfigId,
    });
  throw new ApiError(409, "A GitHub write credential is required");
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
    path: `${params.base}/branches/${encodeURIComponent(params.branch)}`,
    token: params.token,
  });
  if (branch.commit?.sha !== params.baseSha)
    throw new ApiError(
      409,
      "GitHub has changed since the last policy sync. Sync and review the new revision.",
    );
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
          path: `${params.base}/git/trees/${treeSha}`,
          token: params.token,
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

/** The text's `[credentials]` lines for variables an included battery reads. */
async function batteryCredentialLines(
  organizationId: string,
  content: string,
): Promise<Map<string, string>> {
  const { entries, credentials } = await openappaDeclarations.resolve({
    organizationId,
    content,
  });
  const read = new Set(
    entries.flatMap((entry) => entry.battery?.credentials ?? []),
  );
  return new Map(
    Object.entries(credentials).filter(([variable]) => read.has(variable)),
  );
}
