import { createHash } from "node:crypto";
import { userHasPermission } from "@/auth";
import config from "@/config";
import logger from "@/logging";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import { openappaBatteriesService } from "@/openappa/batteries";
import { addedGrants, openappaDeclarations } from "@/openappa/declarations";
import { readResponseBodyWithLimit } from "@/plugins/bounded-response";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import {
  resolveGithubAppInstallationToken,
  resolveGithubPatToken,
} from "@/skills/github-app-token";
import { ApiError } from "@/types";
import type {
  AppaGithubSource,
  HeldPullReason,
} from "@/types/openappa-github-sync";

export async function getAppaGithubSync(organizationId: string) {
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row)
    return { enabled: config.openappa.enabled, source: null, hasPolicy: false };
  // Neither the accepted bytes nor the held ones leave the database: the panel
  // reads a held pull by its hash, its commit and its reasons.
  const { content, heldContent, ...source } = row;
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

/**
 * Publish a held pull on an operator's authority. Each reason the hold names
 * carries its own permission, since a hold is exactly the authorization a pull
 * cannot give itself: `drops_batteries` takes the permissions a policy write
 * takes, `changes_credentials` the one a credential grant takes.
 */
export async function acceptHeldAppaGithubPull(params: {
  organizationId: string;
  userId: string;
}) {
  assertEnabled();
  const { organizationId, userId } = params;
  const row = await OpenAppaGithubSyncModel.find(organizationId);
  if (!row?.heldContent || !row.heldContentHash)
    throw new ApiError(409, "There is no held pull to accept");
  if (
    row.heldReasons.includes("changes_credentials") &&
    !(await userHasPermission(userId, organizationId, "credential", "update"))
  )
    throw new ApiError(
      403,
      "Credential update permission is required: this pull changes which credentials batteries read",
    );
  const local = await guardrailsPolicyService.get(organizationId);
  const changes = await heldChanges({
    organizationId,
    local: local.content,
    pulled: row.heldContent,
    // The record of what was accepted has to name the batteries the pull drops,
    // whatever the flag says by now: the hold is why they are being named.
    pendingPublish:
      row.declarationsPendingPublish ||
      row.heldReasons.includes("drops_batteries"),
  });
  const published = await OpenAppaGithubSyncModel.publishHeld({
    organizationId,
    userId,
    heldContentHash: row.heldContentHash,
  });
  if (!published) throw new ApiError(409, "There is no held pull to accept");
  await openappaBatteriesService.recompileOrganizations([organizationId]);
  return {
    accepted: {
      contentHash: published.contentHash,
      sourceCommit: published.sourceCommit,
      reasons: row.heldReasons,
      droppedBatteries: changes.dropped,
      changedVariables: changes.granted.map((grant) => grant.variable),
    },
    status: await getAppaGithubSync(organizationId),
  };
}

export async function syncAppaGithubPolicy(organizationId: string) {
  if (!config.openappa.enabled) return;
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
    const token = await resolveToken(row);
    const headers = {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const base = `https://api.github.com/repos/${repo}`;
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
      `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${commit.sha}`,
      { ...headers, Accept: "application/vnd.github.raw+json" },
    );
    const bytes = await readResponseBodyWithLimit(response, 1024 * 1024);
    if (!bytes) throw new ApiError(400, "APPA policy exceeds the 1 MiB limit");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const local = await guardrailsPolicyService.get(organizationId);
    const validation = await guardrailsPolicyService
      .validate(content, { organizationId, previous: local.content })
      .catch((error) => {
        logger.warn(
          { organizationId, error },
          "A pulled APPA policy could not be checked",
        );
        return { valid: false, errors: [] };
      });
    if (!validation.valid)
      throw new ApiError(
        400,
        "APPA rejected this policy. Use a valid, self-contained TOML policy whose battery includes this deployment can answer.",
      );
    const changes = await heldChanges({
      organizationId,
      local: local.content,
      pulled: content,
      pendingPublish: row.declarationsPendingPublish,
    });
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (changes.reasons.length > 0) {
      await OpenAppaGithubSyncModel.hold({
        organizationId,
        revision: row.revision,
        content,
        contentHash,
        sourceCommit: commit.sha,
        reasons: changes.reasons,
        error: holdMessage(changes),
      });
      return;
    }
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
        "An APPA GitHub pull was discarded: the source changed while it downloaded",
      );
      return;
    }
    if (row.declarationsPendingPublish)
      await OpenAppaGithubSyncModel.setDeclarationsPendingPublish(
        organizationId,
        false,
      );
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

/**
 * What a pulled document changes that the repository cannot authorize on its own:
 * a credential grant it adds or rekeys, and — while this deployment's own
 * declarations are not in the repository yet — a battery it would drop.
 */
async function heldChanges(params: {
  organizationId: string;
  local: string;
  pulled: string;
  pendingPublish?: boolean;
}): Promise<{
  reasons: HeldPullReason[];
  granted: Array<{ battery: string; variable: string; key: string }>;
  dropped: string[];
}> {
  const { organizationId } = params;
  const local = await openappaDeclarations.resolve({
    organizationId,
    content: params.local,
  });
  const pulled = await openappaDeclarations.resolve({
    organizationId,
    content: params.pulled,
  });
  const granted = addedGrants(
    openappaDeclarations.grants(local),
    openappaDeclarations.grants(pulled),
  );
  const included = new Set(pulled.entries.map((entry) => entry.name));
  const dropped = params.pendingPublish
    ? local.entries
        .map((entry) => entry.name)
        .filter((name) => !included.has(name))
    : [];
  const reasons: HeldPullReason[] = [];
  if (dropped.length > 0) reasons.push("drops_batteries");
  if (granted.length > 0) reasons.push("changes_credentials");
  return { reasons, granted, dropped };
}

function holdMessage(changes: {
  reasons: HeldPullReason[];
  granted: Array<{ battery: string; variable: string }>;
  dropped: string[];
}): string {
  const parts: string[] = [];
  if (changes.reasons.includes("drops_batteries"))
    parts.push(
      `drops_batteries: the repository does not include ${changes.dropped.join(", ")}`,
    );
  if (changes.reasons.includes("changes_credentials"))
    parts.push(
      `changes_credentials: it hands ${changes.granted
        .map((grant) => `${grant.variable} to ${grant.battery}`)
        .join(", ")}`,
    );
  return `This pull was not published. ${parts.join("; ")}. Accept it in the guardrails panel.`;
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
