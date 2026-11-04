import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  type GitHubActionsAccess,
  type GitHubActionsTokenErrorCode,
  gitHubRepositoryMatches,
  isGitHubActionsAppCredential,
} from "@archestra/shared";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { CacheKey, cacheManager } from "@/cache-manager";
import {
  createRepositoryInstallationToken,
  GITHUB_INSTALLATION_TOKEN_REFUSED,
  resolveInstallationCredential,
} from "@/integrations/github/app-auth";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  RuntimeCredentialConnectionModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { MCP_GATEWAY_PREFIX } from "@/routes/route-paths";
import { CredentialAccess } from "@/services/credential-access";
import { githubUserConnectionManager } from "@/services/github-user-connection";
import {
  buildOAuthIssuer,
  MCP_RESOURCE_REFERENCE_PREFIX,
} from "@/services/identity-providers/enterprise-managed/authorization";
import { jwksValidator } from "@/services/jwks-validator";
import { ResourcePermissions } from "@/services/resource-permissions";
import {
  type AgentAccessContext,
  type AgentType,
  ApiError,
  GITHUB_COM_API_URL,
  GitHubUserIdSchema,
} from "@/types";
import type {
  GitHubActionsTokenError,
  GitHubActionsTokenResponse,
} from "@/types/github-actions-token";
import { isUuid } from "@/utils/uuid";

/**
 * Trade a GitHub Actions OIDC token from a pull-request job for a token on an
 * MCP gateway, plus a GitHub App installation token for that one repository.
 * The gateway token acts as the pull request's author, or with `actAs:
 * "actor"` as whoever started the run. Every check fails closed.
 */
export async function exchangeGitHubActionsToken(params: {
  token: string;
  resource: string;
}): Promise<
  | { ok: true; body: GitHubActionsTokenResponse }
  | {
      ok: false;
      statusCode: 400 | 401 | 403 | 500 | 502;
      body: GitHubActionsTokenError;
    }
> {
  const gatewayRef = parseGatewayResource(params.resource);
  if (!gatewayRef)
    return refuse(
      400,
      "invalid_request",
      `resource must be an MCP gateway URL of this deployment: ${buildOAuthIssuer()}${MCP_GATEWAY_PREFIX}/<gateway id or slug>`,
    );

  const claims = await verifyOidcToken(params.token);
  if (!claims)
    return refuse(
      401,
      "invalid_token",
      `The GitHub Actions OIDC token is not valid here. Request it with the audience ${buildOAuthIssuer()}.`,
    );

  // Until the run is trusted, every refusal reads the same, so a caller with
  // any GitHub token cannot map out which gateways accept which runs.
  const run = {
    resource: params.resource,
    repository: claims.repository,
    workflow: claims.job_workflow_ref,
    event: claims.event_name,
    ref: claims.ref,
  };
  const gatewayId = await AgentModel.resolveIdFromIdOrSlug(gatewayRef);
  const gateway = gatewayId
    ? await AgentModel.findGitHubActionsGateway(gatewayId)
    : null;
  if (!gatewayId || !gateway) return untrusted("no such gateway", run);
  if (gateway.agentType !== "mcp_gateway")
    return untrusted("not an MCP gateway", run);
  const access = gateway.githubActionsAccess;
  if (!access) return untrusted("GitHub Actions access is off", run);
  const { repository } = claims;
  const pullNumber = Number(PULL_REQUEST_MERGE_REF.exec(claims.ref)?.[1]);
  if (claims.event_name !== "pull_request")
    return untrusted("event is not pull_request", run);
  if (!Number.isSafeInteger(pullNumber))
    return untrusted("ref is not a pull request merge ref", run);
  if (
    !access.repositories.some((allowed) =>
      gitHubRepositoryMatches(allowed, repository),
    )
  )
    return untrusted("repository is not listed", run);
  if (!access.workflows.includes(claims.job_workflow_ref))
    return untrusted("workflow is not trusted", run);

  const app = await resolveGitHubApp({
    organizationId: gateway.organizationId,
    key: access.githubAppCredentialKey,
  });
  if (!app)
    return refuse(
      403,
      "not_trusted",
      "This gateway's GitHub App credential is missing or has no private key.",
    );

  let pullRequest: PullRequest | null;
  try {
    pullRequest = await readPullRequest({ app, repository, pullNumber });
  } catch (error) {
    return githubFailure({ error, gatewayId, repository });
  }
  if (!pullRequest)
    return refuse(
      403,
      "not_trusted",
      `The GitHub App cannot read pull request #${pullNumber} in ${repository}. Install the App on that repository.`,
    );
  // The token acts as whoever started the run. By default that must be the
  // author: a collaborator who pushes to someone else's pull request, or
  // labels it, starts a run too. With actAs "actor", the trusted workflow
  // decides whose runs to start, and each person spends their own account.
  // The caller's own workflow file is not trusted: the pull request can edit it.
  const actsAsActor = access.actAs === "actor";
  const login = claims.actor;
  if (
    pullRequest.head.repo?.full_name.toLowerCase() !== repository.toLowerCase()
  )
    return refuse(
      403,
      "not_trusted",
      "Pull requests from forks, or whose head repository no longer exists, cannot use this gateway.",
      actsAsActor ? login : pullRequest.user.login,
    );
  if (!actsAsActor && claims.actor_id !== pullRequest.user.id)
    return refuse(
      403,
      "not_author",
      `This run was started by ${login} on a pull request by ${pullRequest.user.login}; this gateway runs only as the author, for runs the author starts.`,
      pullRequest.user.login,
    );

  const connections =
    await RuntimeCredentialConnectionModel.findGitHubAppConnections({
      organizationId: gateway.organizationId,
      githubAppCredentialKey: access.githubAppCredentialKey,
      githubId: claims.actor_id,
    });
  const userIds = [...new Set(connections.map((entry) => entry.userId))];
  const appName = archestraMcpBranding.appName;
  if (userIds.length === 0)
    return refuse(
      403,
      "not_linked",
      `GitHub user ${login} has not connected GitHub to a ${appName} account. Sign in to ${appName}, open ${PERSONAL_CREDENTIALS_PATH}, connect GitHub, then re-run the workflow.`,
      login,
    );
  if (userIds.length > 1)
    return refuse(
      403,
      "ambiguous_link",
      `GitHub user ${login} is connected to more than one ${appName} account. Disconnect GitHub from all but one of them under ${PERSONAL_CREDENTIALS_PATH}.`,
      login,
    );
  const [userId] = userIds;

  if (!(await userCanUseGateway({ userId, gateway })))
    return refuse(
      403,
      "forbidden",
      `The ${appName} account of GitHub user ${login} cannot use this MCP gateway.`,
      login,
    );

  let linked: boolean;
  try {
    linked = await hasUsableConnection({
      organizationId: gateway.organizationId,
      userId,
      credentialKeys: connections.map((entry) => entry.credentialKey),
      githubId: claims.actor_id,
    });
  } catch (error) {
    // GitHub could not say whether the connection still works.
    if (error instanceof ApiError && error.statusCode === 502)
      return githubFailure({ error, gatewayId, repository });
    throw error;
  }
  if (!linked)
    return refuse(
      403,
      "not_linked",
      `The GitHub connection of ${login} in ${appName} has expired or was revoked. Sign in to ${appName}, open ${PERSONAL_CREDENTIALS_PATH}, connect GitHub again, then re-run the workflow.`,
      login,
    );

  if (!(await claimTokenId(claims)))
    return refuse(
      401,
      "invalid_token",
      "This GitHub Actions OIDC token was already exchanged. Request a new one.",
    );

  let gatewayToken: { value: string; hash: string } | null = null;
  try {
    gatewayToken = await mintGatewayAccessToken({ gatewayId, userId });
    // By id: a name can belong to another account once an owner is renamed
    // and its old name taken, and must never reach its repository.
    let githubToken: { token: string; expiresAt: number };
    let contents: "read" | "write" = access.resolveReviewThreads
      ? "write"
      : "read";
    try {
      githubToken = await createRepositoryInstallationToken({
        ...app,
        repositoryId: claims.repository_id,
        permissions: { ...GITHUB_TOKEN_PERMISSIONS, contents },
      });
    } catch (firstError) {
      // An App installed without contents: write still reviews; it cannot
      // resolve review threads. Any other failure is reported as it is.
      if (
        !access.resolveReviewThreads ||
        !(firstError instanceof ApiError) ||
        firstError.internalCode !== GITHUB_INSTALLATION_TOKEN_REFUSED
      ) {
        await OAuthAccessTokenModel.deleteByTokenHash(gatewayToken.hash);
        return githubFailure({ error: firstError, gatewayId, repository });
      }
      logger.info(
        { gatewayId, repository, ...describeError(firstError) },
        "[github-actions] No repository token with contents: write; trying contents: read",
      );
      contents = "read";
      try {
        githubToken = await createRepositoryInstallationToken({
          ...app,
          repositoryId: claims.repository_id,
          permissions: GITHUB_TOKEN_PERMISSIONS,
        });
      } catch (error) {
        await OAuthAccessTokenModel.deleteByTokenHash(gatewayToken.hash);
        return githubFailure({ error, gatewayId, repository });
      }
    }

    logger.info(
      {
        organizationId: gateway.organizationId,
        gatewayId,
        repository,
        pullRequest: pullNumber,
        githubLogin: login,
        pullRequestAuthor: pullRequest.user.login,
        actAs: access.actAs ?? "author",
        // write only when the run's GitHub token can resolve review threads.
        contents,
        userId,
      },
      "[github-actions] Issued an MCP gateway token for a GitHub Actions run",
    );

    return {
      ok: true,
      body: {
        access_token: gatewayToken.value,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
        github_token: githubToken.token,
        github_token_expires_at: new Date(githubToken.expiresAt).toISOString(),
        github_login: login,
        user_id: userId,
      },
    };
  } catch (error) {
    // Nobody holds a token minted before the failure; take it back.
    if (gatewayToken)
      await OAuthAccessTokenModel.deleteByTokenHash(gatewayToken.hash).catch(
        () => undefined,
      );
    logger.error(
      { gatewayId, repository, ...describeError(error) },
      "[github-actions] Token exchange failed",
    );
    return refuse(
      500,
      "server_error",
      "The token exchange failed. Request a new OIDC token and try again.",
    );
  }
}

/**
 * Refuse a GitHub Actions setting the editor could not have set up
 * themselves. Unchanged and cleared settings pass, so unrelated edits and
 * turning the exchange off never need the App.
 */
export async function assertGitHubActionsAccessChange(params: {
  organizationId: string;
  userId: string;
  agentType: AgentType;
  previous: GitHubActionsAccess | null;
  next: GitHubActionsAccess | null | undefined;
}): Promise<void> {
  const { next } = params;
  if (!next || isDeepStrictEqual(params.previous, next)) return;
  if (params.agentType !== "mcp_gateway")
    throw new ApiError(
      400,
      "GitHub Actions access can only be set on an MCP gateway",
    );
  // Any change hands GitHub Actions jobs tokens of the App, so the editor
  // must be allowed to use it.
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  await CredentialAccess.requireUseOfNewKeys({
    organizationId: params.organizationId,
    userId: params.userId,
    previous: [],
    next: [next.githubAppCredentialKey],
  });
  // SPDX-SnippetEnd
  const definition = await RuntimeCredentialDefinitionModel.find({
    organizationId: params.organizationId,
    key: next.githubAppCredentialKey,
  });
  if (!isGitHubActionsAppCredential(definition))
    throw new ApiError(
      400,
      "Pick an organization GitHub App credential for GitHub.com with an app ID and installation ID",
    );
}

// ===================== Internals =====================

const GITHUB_ACTIONS_OIDC_ISSUER =
  "https://token.actions.githubusercontent.com";
const GITHUB_ACTIONS_OIDC_JWKS_URL = `${GITHUB_ACTIONS_OIDC_ISSUER}/.well-known/jwks`;
const ACCESS_TOKEN_LIFETIME_SECONDS = 3 * 60 * 60;
const PULL_REQUEST_MERGE_REF = /^refs\/pull\/(\d+)\/merge$/;
/** A slug the agents table generates: lowercase words joined by hyphens. */
const GATEWAY_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/;
const PERSONAL_CREDENTIALS_PATH = "/account/credentials";
const UNTRUSTED_RUN_MESSAGE =
  "This MCP gateway does not accept this GitHub Actions run.";
const UNUSABLE_APP_MESSAGE =
  "The GitHub App credential could not be used; check its private key, App ID and installation ID.";
/**
 * Enough to read the change and post a review; issue comments are not needed.
 * A gateway with resolveReviewThreads adds contents: write, which GitHub
 * requires to resolve a review thread.
 */
const GITHUB_TOKEN_PERMISSIONS = {
  pull_requests: "write",
  contents: "read",
  checks: "read",
  metadata: "read",
} as const;
/** Owns the gateway tokens this exchange issues; no OAuth flow can use it. */
const GITHUB_ACTIONS_OAUTH_CLIENT_ID = "archestra-github-actions";
/** The validator accepts a token this long after its `exp`. */
const CLOCK_TOLERANCE_MS = 30_000;

const OidcClaimsSchema = z.object({
  jti: z.string().min(1),
  exp: z.number(),
  event_name: z.string(),
  ref: z.string(),
  repository: z.string(),
  /**
   * GitHub's id of the repository, which a rename or a reused owner name
   * cannot change; GitHub sends it as a string.
   */
  repository_id: z
    .union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive()])
    .transform(Number),
  job_workflow_ref: z.string(),
  /**
   * Who started the run, whom the gateway token acts as; GitHub sends the
   * numeric id as a string.
   */
  actor_id: z
    .union([z.string().regex(/^[1-9]\d*$/), z.number().int().positive()])
    .transform(Number)
    .pipe(GitHubUserIdSchema),
  actor: z.string().min(1),
});
type OidcClaims = z.infer<typeof OidcClaimsSchema>;

/** The account `GET /user` names for a user token. */
const GitHubAccountSchema = z.object({ id: z.number() });

const PullRequestSchema = z.object({
  user: z.object({ id: GitHubUserIdSchema, login: z.string() }),
  head: z.object({
    // Null once the fork a pull request came from is deleted.
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
});
type PullRequest = z.infer<typeof PullRequestSchema>;

type GitHubApp = {
  githubUrl: string;
  appId: string;
  installationId: string;
  privateKey: string;
};

function refuse(
  statusCode: 400 | 401 | 403 | 500 | 502,
  error: GitHubActionsTokenErrorCode,
  message: string,
  login?: string,
) {
  return {
    ok: false as const,
    statusCode,
    body: { error, message, ...(login ? { login } : {}) },
  };
}

/** The one answer for a run the gateway does not accept; the reason is logged. */
function untrusted(
  reason: string,
  run: {
    resource: string;
    repository: string;
    workflow: string;
    event: string;
    ref: string;
  },
) {
  logger.info(
    { ...run, reason },
    "[github-actions] Refused an untrusted workflow run",
  );
  return refuse(403, "not_trusted", UNTRUSTED_RUN_MESSAGE);
}

function githubFailure(params: {
  error: unknown;
  gatewayId: string;
  repository: string;
}) {
  const { error } = params;
  const context = {
    gatewayId: params.gatewayId,
    repository: params.repository,
  };
  // GitHub answered, or the credential was refused with a reason worth showing.
  if (error instanceof ApiError) {
    logger.warn(
      { ...context, error: error.message },
      "[github-actions] GitHub request failed during token exchange",
    );
    return refuse(502, "github_error", error.message);
  }
  logger.warn(
    { ...context, ...describeError(error) },
    "[github-actions] GitHub request failed during token exchange",
  );
  if (isNetworkFailure(error))
    return refuse(
      502,
      "github_error",
      "GitHub could not be reached. Try again.",
    );
  // A local failure: the key does not parse or cannot sign.
  return refuse(502, "github_error", UNUSABLE_APP_MESSAGE);
}

/** An error's class and message, never the values it was given. */
function describeError(error: unknown) {
  return error instanceof Error
    ? { errorClass: error.name, error: error.message }
    : { errorClass: typeof error, error: String(error) };
}

/** fetch rejects with a TypeError when no response arrives, and times out by name. */
function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.name === "AbortError" ||
      (error instanceof TypeError && /fetch/i.test(error.message)))
  );
}

/**
 * The gateway id or slug in this deployment's MCP gateway URL, or null for
 * anything else. Checked before any lookup, since the id column is a uuid.
 */
function parseGatewayResource(resource: string): string | null {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return null;
  }
  if (url.origin !== new URL(buildOAuthIssuer()).origin) return null;
  const prefix = `${MCP_GATEWAY_PREFIX}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  let segment: string;
  try {
    segment = decodeURIComponent(url.pathname.slice(prefix.length));
  } catch {
    return null;
  }
  return isUuid(segment) || GATEWAY_SLUG.test(segment) ? segment : null;
}

async function verifyOidcToken(token: string): Promise<OidcClaims | null> {
  const issuer = buildOAuthIssuer();
  const verified = await jwksValidator.validateJwt({
    token,
    issuerUrl: GITHUB_ACTIONS_OIDC_ISSUER,
    jwksUrl: GITHUB_ACTIONS_OIDC_JWKS_URL,
    // The trailing-slash form, as the OAuth issuer was once advertised.
    audience: [issuer, `${issuer}/`],
  });
  if (!verified) return null;
  // jose only enforces `exp` when present; GitHub always sets it, so a token
  // without one is not GitHub's.
  const claims = OidcClaimsSchema.safeParse(verified.rawClaims);
  return claims.success ? claims.data : null;
}

async function resolveGitHubApp(params: {
  organizationId: string;
  key: string;
}): Promise<GitHubApp | null> {
  const definition = await RuntimeCredentialDefinitionModel.find(params);
  if (!isGitHubActionsAppCredential(definition)) return null;
  const privateKey = await RuntimeCredentialConnectionModel.resolveValue({
    organizationId: params.organizationId,
    credentialId: params.key,
    scope: "organization",
  });
  if (!privateKey) return null;
  return {
    githubUrl: definition.githubUrl,
    appId: definition.appId,
    installationId: definition.installationId,
    privateKey,
  };
}

/** The pull request, or null when the App cannot see it. */
async function readPullRequest(params: {
  app: GitHubApp;
  repository: string;
  pullNumber: number;
}): Promise<PullRequest | null> {
  const { token } = await resolveInstallationCredential(params.app);
  const [owner, name] = params.repository.split("/");
  const response = await fetch(
    `${params.app.githubUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls/${params.pullNumber}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok)
    throw new ApiError(
      502,
      `GitHub returned HTTP ${response.status} for pull request #${params.pullNumber} in ${params.repository}`,
    );
  const pullRequest = PullRequestSchema.safeParse(await response.json());
  if (!pullRequest.success)
    throw new ApiError(
      502,
      `GitHub returned an unexpected pull request #${params.pullNumber} in ${params.repository}`,
    );
  return pullRequest.data;
}

/** The same check the gateway applies to the token on every request. */
async function userCanUseGateway(params: {
  userId: string;
  gateway: AgentAccessContext;
}): Promise<boolean> {
  const isGatewayAdmin = await ResourcePermissions.allows({
    userId: params.userId,
    organizationId: params.gateway.organizationId,
    resource: "mcpGateway",
    scope: "*",
    action: "update",
  });
  return AgentTeamModel.userHasAgentAccess({
    userId: params.userId,
    agentId: params.gateway.id,
    isAgentAdmin: isGatewayAdmin,
    agentAccessContext: params.gateway,
    action: "use",
  });
}

/**
 * Whether one of the user's connections still acts as that GitHub account.
 * Each is resolved as a runtime launch would (refreshing it when due), then
 * shown to GitHub: a stored token that has not expired locally may still have
 * been revoked. Throws a 502 `ApiError` when GitHub cannot answer.
 */
async function hasUsableConnection(params: {
  organizationId: string;
  userId: string;
  credentialKeys: string[];
  githubId: number;
}): Promise<boolean> {
  for (const credentialId of params.credentialKeys) {
    let resolved: { value: string } | null;
    try {
      resolved = await githubUserConnectionManager.resolve({
        organizationId: params.organizationId,
        userId: params.userId,
        credentialId,
      });
    } catch (error) {
      // GitHub sign-in reports a revoked, expired, or reconfigured
      // authorization as a 400; anything else is a failure of its own.
      if (!(error instanceof ApiError) || error.statusCode !== 400) throw error;
      logger.info(
        { userId: params.userId, credentialId, error: error.message },
        "[github-actions] A GitHub connection can no longer be used",
      );
      continue;
    }
    if (!resolved) continue;
    if (
      await gitHubAcceptsAs({
        token: resolved.value,
        githubId: params.githubId,
      })
    )
      return true;
    logger.info(
      { userId: params.userId, credentialId },
      "[github-actions] GitHub refused a connection's token, or it acts as another account",
    );
  }
  return false;
}

/** Whether GitHub accepts the user token, as the given account. */
async function gitHubAcceptsAs(params: {
  token: string;
  githubId: number;
}): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${GITHUB_COM_API_URL}/user`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${params.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new ApiError(
      502,
      "GitHub could not be reached to check the GitHub connection. Try again.",
    );
  }
  // GitHub also answers 403 when it throttles a valid token: that is a
  // transient failure, not a revoked connection.
  if (response.status === 403 && (await isRateLimited(response)))
    throw new ApiError(
      502,
      "GitHub rate-limited the check of the GitHub connection. Try again later.",
    );
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok)
    throw new ApiError(
      502,
      `GitHub returned HTTP ${response.status} while checking the GitHub connection`,
    );
  const user = GitHubAccountSchema.safeParse(await response.json());
  if (!user.success)
    throw new ApiError(
      502,
      "GitHub returned an unexpected account while checking the GitHub connection",
    );
  return user.data.id === params.githubId;
}

/**
 * GitHub's primary limit (no requests left), or a secondary limit: it may say when to retry, and
 * it always says so in its message, also when it sends no header.
 */
async function isRateLimited(response: Response): Promise<boolean> {
  if (
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after")
  )
    return true;
  const body = await response.text().catch(() => "");
  return /rate limit/i.test(body);
}

/** Record the token's `jti` until it expires; false when it is already there. */
async function claimTokenId(claims: OidcClaims): Promise<boolean> {
  const key =
    `${CacheKey.GitHubActionsTokenJti}-${createHash("sha256").update(claims.jti).digest("hex")}` as const;
  // Until the token can no longer pass validation: its expiry plus the
  // validator's clock tolerance, on both sides. GitHub's tokens live minutes;
  // the one-hour cap only bounds the cache entry of a token that claims a
  // longer life, which GitHub never issues.
  const ttl = Math.min(
    Math.max(claims.exp * 1000 - Date.now(), 0) + 2 * CLOCK_TOLERANCE_MS,
    60 * 60 * 1000,
  );
  return cacheManager.withLock(key, async (cache) => {
    if (await cache.get<boolean>(key)) return false;
    await cache.set(key, true, ttl);
    return true;
  });
}

async function mintGatewayAccessToken(params: {
  gatewayId: string;
  userId: string;
}): Promise<{ value: string; hash: string }> {
  await OAuthClientModel.ensurePlatformIssuedClient({
    id: GITHUB_ACTIONS_OAUTH_CLIENT_ID,
    clientId: GITHUB_ACTIONS_OAUTH_CLIENT_ID,
    name: "GitHub Actions",
  });
  const value = randomBytes(32).toString("base64url");
  const hash = OAuthAccessTokenModel.hashTokenForLookup(value);
  await OAuthAccessTokenModel.create({
    tokenHash: hash,
    clientId: GITHUB_ACTIONS_OAUTH_CLIENT_ID,
    userId: params.userId,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000),
    scopes: ["mcp"],
    referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${params.gatewayId}`,
  });
  return { value, hash };
}
