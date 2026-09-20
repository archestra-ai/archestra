import { createHash } from "node:crypto";
import { userHasPermission } from "@/auth";
import config from "@/config";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { openappaBatteriesService } from "@/openappa/batteries";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import {
  resolveGithubAppInstallationToken,
  resolveGithubPatToken,
} from "@/skills/github-app-token";
import { ApiError } from "@/types";
import type { AppaGithubSource } from "@/types/openappa-github-sync";

export async function getAppaGithubSync(organizationId: string) {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row)
    return { enabled: config.openappa.enabled, source: null, hasPolicy: false };
  const { content, ...source } = row;
  return {
    enabled: config.openappa.enabled,
    source,
    hasPolicy: content !== null,
  };
}
export async function configureAppaGithubSync(params: {
  organizationId: string;
  userId: string;
  source: AppaGithubSource;
}) {
  assertEnabled();
  if (
    (params.source.githubPatId || params.source.githubAppConfigId) &&
    !(await userHasPermission(
      params.userId,
      params.organizationId,
      "credential",
      "read",
    ))
  ) {
    throw new ApiError(403, "You do not have access to GitHub credentials");
  }
  // Resolve now to reject a missing or cross-organization credential before saving it.
  await resolveToken({
    ...params.source,
    organizationId: params.organizationId,
  });
  await OpenAppaGithubSyncModel.save(params.organizationId, params.source);
  await OpenAppaGithubSyncModel.enqueue(params.organizationId);
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
    await OpenAppaGithubSyncModel.enqueue(params.organizationId);
  else
    await OpenAppaGithubSyncModel.setInterval(
      params.organizationId,
      params.action === "disconnect" ? null : (params.interval ?? row.interval),
    );
  return getAppaGithubSync(params.organizationId);
}
export async function syncAppaGithubPolicy(organizationId: string) {
  if (!config.openappa.enabled) return;
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row?.interval) return;
  try {
    const token = await resolveToken(row);
    const headers = {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const base = `https://api.github.com/repos/${row.repo}`;
    const commitResponse = await githubFetch(
      `${base}/commits/${encodeURIComponent(row.ref ?? "HEAD")}`,
      headers,
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
      `${base}/contents/${row.path.split("/").map(encodeURIComponent).join("/")}?ref=${commit.sha}`,
      { ...headers, Accept: "application/vnd.github.raw+json" },
    );
    const bytes = await readResponseBodyWithLimit(response, 1024 * 1024);
    if (!bytes) throw new ApiError(400, "APPA policy exceeds the 1 MiB limit");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const native = await import("@archestra/openappa-rs");
    try {
      const errors = await native.validateOpenappaPolicy(content);
      if (errors.length > 0) throw new Error("Invalid APPA policy");
    } catch {
      throw new ApiError(
        400,
        "APPA rejected this policy. Use a valid, self-contained TOML policy without includes or local command bindings.",
      );
    }
    await OpenAppaGithubSyncModel.finish({
      organizationId,
      revision: row.revision,
      outcome: {
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        sourceCommit: commit.sha,
      },
    });
    await openappaBatteriesService.recompileOrganizations([organizationId]);
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
}
export async function checkDueAppaGithubSyncs() {
  if (!config.openappa.enabled) return;
  for (const row of await OpenAppaGithubSyncModel.findDue())
    await OpenAppaGithubSyncModel.enqueue(row.organizationId);
}
function assertEnabled() {
  if (!config.openappa.enabled)
    throw new ApiError(
      409,
      "Enable OpenAPPA on the server before configuring GitHub sync",
    );
}
async function resolveToken(source: {
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
  return undefined;
}
async function githubFetch(url: string, headers: Record<string, string>) {
  const response = await fetch(url, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new ApiError(
      400,
      `GitHub returned HTTP ${response.status}. Check repository access and the source path.`,
    );
  return response;
}
