import { createHash, randomUUID } from "node:crypto";
import { userHasPermission } from "@/auth";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import OpenAppaGithubSyncModel from "@/models/openappa-github-sync";
import OpenAppaPolicyTestsModel from "@/models/openappa-policy-tests";
import { openappaBatteriesService } from "@/openappa/batteries";
import {
  addedGrants,
  openappaDeclarations,
  type PolicyResolution,
} from "@/openappa/declarations";
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
  const [row, suite] = await Promise.all([
    OpenAppaGithubSyncModel.find(organizationId),
    OpenAppaPolicyTestsModel.find(organizationId),
  ]);
  const validationDirectory = row?.repo ? (suite?.directory ?? "traces") : "";
  if (!row)
    return {
      enabled: enterpriseTier.isOpenappaActive(),
      source: null,
      hasPolicy: false,
      validationDirectory,
    };
  // Neither the accepted bytes nor the held ones leave the database: the panel
  // reads a held pull by its hash, its commit and its reasons.
  const { content, heldContent, ...source } = row;
  return {
    enabled: enterpriseTier.isOpenappaActive(),
    source,
    hasPolicy: content !== null,
    validationDirectory,
  };
}
export async function configureAppaGithubSync(params: {
  organizationId: string;
  userId: string;
  source: AppaGithubSource;
}) {
  assertEnabled();
  await saveSource(params);
  await OpenAppaGithubSyncModel.enqueue(params.organizationId);
  return getAppaGithubSync(params.organizationId);
}

/**
 * Make an existing repository's policy file the organization's policy source
 * and pull it before answering, so the caller learns at once whether the
 * repository, file and credential work. A first pull that fails leaves the
 * sync stopped and the current policy in force; a held pull stays connected
 * for an operator to accept.
 */
export async function connectAppaGithubRepository(params: {
  organizationId: string;
  userId: string;
  source: AppaGithubSource;
}) {
  assertEnabled();
  if ((await OpenAppaGithubSyncModel.find(params.organizationId))?.interval)
    throw new ApiError(
      409,
      "Stop the existing GitHub sync before connecting another repository",
    );
  await saveSource(params);
  await syncAppaGithubPolicy(params.organizationId);
  const row = await OpenAppaGithubSyncModel.find(params.organizationId);
  if (row?.lastSyncError && !row.heldContentHash) {
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
  githubAppConfigId: string;
  interval: AppaGithubSource["interval"];
}) {
  assertEnabled();
  if ((await OpenAppaGithubSyncModel.find(params.organizationId))?.interval)
    throw new ApiError(
      409,
      "Stop the existing GitHub sync before creating a repository",
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
  const token = await resolveGithubAppInstallationToken(params);
  const policy = await guardrailsPolicyService.get(params.organizationId);
  if (Buffer.byteLength(policy.content) > 1024 * 1024)
    throw new ApiError(
      400,
      "The current policy exceeds the 1 MiB GitHub sync limit",
    );

  let created: {
    full_name?: string;
    default_branch?: string;
    private?: boolean;
  };
  const repo = `${params.owner}/${params.name}`;
  try {
    created = await githubJson({
      url: `https://api.github.com/repos/${TEMPLATE_REPO}/generate`,
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
    created = await recoverPristineTemplateRepository({ repo, token, error });
  }
  if (
    created.full_name?.toLowerCase() !== repo.toLowerCase() ||
    !created.default_branch ||
    !/^[^\p{Cc}\s~^:?*[\\]+$/u.test(created.default_branch)
  )
    throw new ApiError(502, "GitHub returned an unexpected repository");
  let setupPullRequestNumber: number | undefined;
  try {
    const base = `https://api.github.com/repos/${repo}`;
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
              /repository rule violations|protected branch update failed|changes must be made through a pull request|required (?:status check|workflow)/i.test(
                message ?? "",
              )
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
          throw new ApiError(502, "GitHub returned an invalid default branch");
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
    githubAppConfigId: params.githubAppConfigId,
    validationDirectory: "",
    setupPullRequestNumber,
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
  const changes = heldChanges({
    ...(await resolvePair({
      organizationId,
      local: local.content,
      pulled: row.heldContent,
    })),
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
  if (local.revision === 0 || local.contentHash !== published.contentHash)
    await queuePolicyValidation(organizationId, published.contentHash);
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
    const token = await resolveToken(row);
    const headers = {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const base = `https://api.github.com/repos/${repo}`;
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
        await OpenAppaGithubSyncModel.finish({
          organizationId,
          revision: row.revision,
          outcome: {
            error:
              pull.state === "closed"
                ? "The initial policy pull request was closed without merging. Reopen and merge it to finish setup, or stop syncing to keep managing the policy locally."
                : null,
          },
        });
        return;
      }
    }
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
    const resolved = await resolvePair({
      organizationId,
      local: local.content,
      pulled: content,
    });
    const validation = await guardrailsPolicyService
      .validate(content, {
        organizationId,
        previous: local.content,
        resolved: { submitted: resolved.pulled, previous: resolved.local },
      })
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
    const changes = heldChanges({
      ...resolved,
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
      "Could not queue informational validation after a policy change",
    );
  }
}
export async function checkDueAppaGithubSyncs() {
  if (!enterpriseTier.isOpenappaActive()) return;
  for (const row of await OpenAppaGithubSyncModel.findDue())
    await OpenAppaGithubSyncModel.enqueue(row.organizationId);
}

/**
 * What a pulled document changes that the repository cannot authorize on its own:
 * a credential grant it adds or rekeys, and — while this deployment's own
 * declarations are not in the repository yet — a battery it would drop.
 */
function heldChanges(params: {
  local: PolicyResolution;
  pulled: PolicyResolution;
  pendingPublish?: boolean;
}): {
  reasons: HeldPullReason[];
  granted: Array<{ battery: string; variable: string; key: string }>;
  dropped: string[];
} {
  const { local, pulled } = params;
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

async function saveSource(params: {
  organizationId: string;
  userId: string;
  source: AppaGithubSource;
}) {
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
  const token = await resolveToken({
    ...params.source,
    organizationId: params.organizationId,
  });
  if (params.source.validationDirectory) {
    const response = await githubFetch(
      `https://api.github.com/repos/${params.source.repo}/commits/${encodeURIComponent(params.source.ref ?? "HEAD")}`,
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

function assertEnabled() {
  if (!enterpriseTier.isOpenappaActive())
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

async function githubJson<T = unknown>(params: {
  url: string;
  token: string;
  method?: "GET" | "POST" | "PUT";
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
      url: `https://api.github.com/repos/${params.repo}`,
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
        url: `https://api.github.com/repos/${params.repo}/contents/appa.toml`,
        token: params.token,
      }),
      githubJson<{ sha?: string }>({
        url: `https://api.github.com/repos/${TEMPLATE_REPO}/contents/appa.toml`,
        token: params.token,
      }),
    ]);
    if (!existing.sha || existing.sha !== template.sha) throw params.error;
    return repository;
  } catch {
    throw params.error;
  }
}

const TEMPLATE_REPO = "archestra-ai/openappa-config";

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
  const token = await resolveToken(source).catch(() => {
    throw new ApiError(400, "The configured GitHub credential is unavailable");
  });
  const signal = AbortSignal.timeout(20000);
  const base = `https://api.github.com/repos/${source.repo}/contents/`;
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
  const entries: unknown = JSON.parse(await read(directory, false, 262144));
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
