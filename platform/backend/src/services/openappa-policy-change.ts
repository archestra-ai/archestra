import { randomUUID } from "node:crypto";
import { userHasPermission } from "@/auth";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { resolveGithubAppInstallationToken } from "@/skills/github-app-token";
import { ApiError } from "@/types";

type ChangeRequest = {
  organizationId: string;
  userId: string;
  content: string;
  expectedRevision: number;
  title: string;
  summary: string;
};

/**
 * Publish a policy change through the configured source of truth. GitHub sync
 * writes a reviewable PR; a locally managed policy saves a revision.
 */
export async function publishOpenAppaPolicyChange(params: ChangeRequest) {
  const source = await OpenAppaGithubSyncModel.find(params.organizationId);
  const before = await guardrailsPolicyService.get(params.organizationId);
  if (before.revision !== params.expectedRevision)
    throw new ApiError(
      409,
      "The policy changed. Read it again before proposing changes.",
    );
  if (before.content === params.content)
    throw new ApiError(400, "The proposed policy has no changes");

  if (!source?.interval) {
    const saved = await guardrailsPolicyService.update(params);
    return {
      delivery: "revision" as const,
      revision: saved.revision,
      before: before.content,
      after: saved.content,
    };
  }

  if (!source.repo || !source.path || !source.githubAppConfigId)
    throw new ApiError(
      409,
      "Connect a GitHub App credential and policy file before proposing changes.",
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

  const validation = await guardrailsPolicyService.validate(params.content, {
    organizationId: params.organizationId,
    previous: before.content,
  });
  if (!validation.valid) throw new ApiError(400, validation.errors.join("\n"));

  const token = await resolveGithubAppInstallationToken({
    organizationId: params.organizationId,
    githubAppConfigId: source.githubAppConfigId,
  });
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

  const path = source.path.split("/").map(encodeURIComponent).join("/");
  const file = await githubJson<{ sha: string }>({
    path: `${base}/contents/${path}?ref=${baseSha}`,
    token,
  });
  if (!file.sha || !/^[a-f0-9]{40}$/.test(file.sha))
    throw new ApiError(502, "GitHub returned an invalid policy file");

  const head = `archestra/openappa-${randomUUID()}`;
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
      content: Buffer.from(params.content).toString("base64"),
      sha: file.sha,
      branch: head,
    },
  });
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
    after: params.content,
  };
}

export async function getOpenAppaPolicyChangeStatus(params: {
  organizationId: string;
  userId: string;
  number: number;
}) {
  const source = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (!source?.interval || !source.repo || !source.githubAppConfigId)
    throw new ApiError(409, "GitHub sync with a GitHub App is not configured");
  if (
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "credential",
      "read",
    ))
  )
    throw new ApiError(403, "GitHub credential read permission is required");
  const token = await resolveGithubAppInstallationToken({
    organizationId: params.organizationId,
    githubAppConfigId: source.githubAppConfigId,
  });
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
      ...(params.body ? { body: JSON.stringify(params.body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new ApiError(502, "Could not reach GitHub");
  }
  if (!response.ok)
    throw new ApiError(
      response.status === 404 ? 404 : 502,
      `GitHub returned HTTP ${response.status}. Check the repository and GitHub App permissions.`,
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
