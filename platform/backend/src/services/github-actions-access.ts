import { createHash, randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { GitHubActionsAccess } from "@archestra/shared";
import { z } from "zod";
import { archestraMcpBranding } from "@/archestra-mcp-server/branding";
import { CacheKey, cacheManager } from "@/cache-manager";
import {
  createRepositoryInstallationToken,
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
import { CredentialAccess } from "@/services/credential-access";
import {
  buildOAuthIssuer,
  extractProfileIdFromMcpResource,
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
  type RuntimeCredentialDefinition,
} from "@/types";
import type {
  GitHubActionsTokenError,
  GitHubActionsTokenResponse,
} from "@/types/github-actions-token";

/**
 * Trade a GitHub Actions OIDC token from a pull-request job for a token on an
 * MCP gateway that acts as the pull request's author, plus a GitHub App
 * installation token for that one repository. Every check fails closed.
 */
export async function exchangeGitHubActionsToken(params: {
  token: string;
  resource: string;
}): Promise<
  | { ok: true; body: GitHubActionsTokenResponse }
  | {
      ok: false;
      statusCode: 400 | 401 | 403 | 502;
      body: GitHubActionsTokenError;
    }
> {
  const gatewayId = extractProfileIdFromMcpResource(params.resource);
  if (!gatewayId)
    return refuse(
      400,
      "invalid_request",
      `resource must be an MCP gateway URL of this deployment: ${buildOAuthIssuer()}/v1/mcp/<gateway id>`,
    );

  const claims = await verifyOidcToken(params.token);
  if (!claims)
    return refuse(
      401,
      "invalid_token",
      `The GitHub Actions OIDC token is not valid here. Request it with the audience ${buildOAuthIssuer()}.`,
    );

  const gateway = await AgentModel.findGitHubActionsGateway(gatewayId);
  const access =
    gateway?.agentType === "mcp_gateway" ? gateway.githubActionsAccess : null;
  if (!gateway || !access)
    return refuse(
      403,
      "not_trusted",
      "This MCP gateway does not accept GitHub Actions tokens.",
    );

  const { repository } = claims;
  const pullNumber = Number(PULL_REQUEST_MERGE_REF.exec(claims.ref)?.[1]);
  if (claims.event_name !== "pull_request" || !Number.isSafeInteger(pullNumber))
    return refuse(
      403,
      "not_trusted",
      "Only workflow runs for a pull_request event can use this gateway.",
    );
  if (
    !access.repositories.some(
      (allowed) => allowed.toLowerCase() === repository.toLowerCase(),
    )
  )
    return refuse(
      403,
      "not_trusted",
      `This gateway does not accept workflow runs from ${repository}.`,
    );
  if (!access.workflows.includes(claims.job_workflow_ref))
    return refuse(
      403,
      "not_trusted",
      `This gateway does not trust the workflow ${claims.job_workflow_ref}.`,
    );

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
  const { login } = pullRequest.user;
  if (
    pullRequest.head.repo?.full_name.toLowerCase() !== repository.toLowerCase()
  )
    return refuse(
      403,
      "not_trusted",
      "Pull requests from forks cannot use this gateway.",
      login,
    );

  const userIds = await RuntimeCredentialConnectionModel.findGitHubAppUserIds({
    organizationId: gateway.organizationId,
    githubAppCredentialKey: access.githubAppCredentialKey,
    githubId: pullRequest.user.id,
  });
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

  if (!(await claimTokenId(claims)))
    return refuse(
      401,
      "invalid_token",
      "This GitHub Actions OIDC token was already exchanged. Request a new one.",
    );

  let githubToken: { token: string; expiresAt: number };
  try {
    githubToken = await createRepositoryInstallationToken({
      ...app,
      repository: repository.slice(repository.indexOf("/") + 1),
      permissions: GITHUB_TOKEN_PERMISSIONS,
    });
  } catch (error) {
    return githubFailure({ error, gatewayId, repository });
  }
  const accessToken = await mintGatewayAccessToken({ gatewayId, userId });

  logger.info(
    {
      organizationId: gateway.organizationId,
      gatewayId,
      repository,
      pullRequest: pullNumber,
      githubLogin: login,
      userId,
    },
    "[github-actions] Issued an MCP gateway token for a pull request author",
  );

  return {
    ok: true,
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
      github_token: githubToken.token,
      github_token_expires_at: new Date(githubToken.expiresAt).toISOString(),
      github_login: login,
      user_id: userId,
    },
  };
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
  if (!isUsableGitHubApp(definition))
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
const PERSONAL_CREDENTIALS_PATH = "/account/credentials";
/** Enough to read the change and post a review; issue comments are not needed. */
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
  job_workflow_ref: z.string(),
});
type OidcClaims = z.infer<typeof OidcClaimsSchema>;

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
  statusCode: 400 | 401 | 403 | 502,
  error: GitHubActionsTokenError["error"],
  message: string,
  login?: string,
) {
  return {
    ok: false as const,
    statusCode,
    body: { error, message, ...(login ? { login } : {}) },
  };
}

function githubFailure(params: {
  error: unknown;
  gatewayId: string;
  repository: string;
}) {
  const message =
    params.error instanceof ApiError
      ? params.error.message
      : "GitHub could not be reached";
  logger.warn(
    {
      gatewayId: params.gatewayId,
      repository: params.repository,
      error: message,
    },
    "[github-actions] GitHub request failed during token exchange",
  );
  return refuse(502, "github_error", message);
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
  if (!isUsableGitHubApp(definition)) return null;
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

function isUsableGitHubApp(
  definition: RuntimeCredentialDefinition | null,
): definition is RuntimeCredentialDefinition & {
  githubUrl: string;
  appId: string;
  installationId: string;
} {
  // GitHub Actions OIDC tokens come from GitHub.com, so the App must live there.
  return (
    definition?.kind === "github_app" &&
    definition.allowOrganization &&
    definition.githubUrl === GITHUB_COM_API_URL &&
    !!definition.appId &&
    !!definition.installationId
  );
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

/** Record the token's `jti` until it expires; false when it is already there. */
async function claimTokenId(claims: OidcClaims): Promise<boolean> {
  const key =
    `${CacheKey.GitHubActionsTokenJti}-${createHash("sha256").update(claims.jti).digest("hex")}` as const;
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
}): Promise<string> {
  await OAuthClientModel.ensurePlatformIssuedClient({
    id: GITHUB_ACTIONS_OAUTH_CLIENT_ID,
    clientId: GITHUB_ACTIONS_OAUTH_CLIENT_ID,
    name: "GitHub Actions",
  });
  const accessToken = randomBytes(32).toString("base64url");
  await OAuthAccessTokenModel.create({
    tokenHash: OAuthAccessTokenModel.hashTokenForLookup(accessToken),
    clientId: GITHUB_ACTIONS_OAUTH_CLIENT_ID,
    userId: params.userId,
    expiresAt: new Date(Date.now() + ACCESS_TOKEN_LIFETIME_SECONDS * 1000),
    scopes: ["mcp"],
    referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${params.gatewayId}`,
  });
  return accessToken;
}
