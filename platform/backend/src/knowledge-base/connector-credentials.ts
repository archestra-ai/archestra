import GithubAppConfigModel from "@/models/github-app-config";
import SecretModel from "@/models/secret";
import { secretManager } from "@/secrets-manager";
import {
  ApiError,
  type ConnectorConfig,
  type ConnectorCredentials,
  type KnowledgeBaseConnector,
} from "@/types";
import { getGoogleDriveOAuthClient } from "./connectors/gdrive/gdrive-oauth";

/**
 * Resolve the runtime credentials a connector authenticates with. GitHub App
 * connectors reference a shared github_app_configs row (App metadata + private
 * key secret); credentialless connectors receive an empty credential object;
 * every other connector uses its own attached secret.
 *
 * `uncached` reads past the secrets cache. Callers that hand the credential to
 * a runtime they also rotate — the Perforce permission-sync shim — need it:
 * the cache is process-local, so a replica that rolls the shim's pod for a
 * changed password could otherwise authenticate the fresh pod with the one it
 * just retired. Ordinary sync paths keep the cached read.
 */
export async function resolveConnectorCredentials(
  connector: Pick<
    KnowledgeBaseConnector,
    "config" | "organizationId" | "secretId"
  >,
  options?: { uncached?: boolean },
): Promise<ConnectorCredentials> {
  const githubAppConfigId = extractGithubAppConfigId(connector.config);
  if (githubAppConfigId) {
    return resolveGithubAppCredentials({
      githubAppConfigId,
      organizationId: connector.organizationId,
      uncached: options?.uncached ?? false,
    });
  }

  if (connector.config.type === "web_crawler") {
    return { apiToken: "" };
  }

  return loadSecretCredentials(connector.secretId, options?.uncached ?? false);
}

/**
 * Version marker for a connector's stored credentials: the secret row's own
 * `updatedAt`, read straight from the database rather than through the
 * secrets cache.
 *
 * Read uncached deliberately. The cache is a 5-minute process-local LRU
 * refreshed only on the replica that handled the write, so a cached read would
 * let a credential rotation go unnoticed here for minutes — and this value is
 * what tells the Perforce shim to retire its pod and token.
 *
 * The connector row's own `updatedAt` cannot serve: a permission-sync pass
 * writes that row on every run, so it would rotate the pod every pass.
 */
export async function resolveConnectorCredentialVersion(
  secretId: string | null,
): Promise<string> {
  if (!secretId) return "";
  const secret = await SecretModel.findById(secretId);
  return secret?.updatedAt?.toISOString() ?? "";
}

// ===== Internal helpers =====

function extractGithubAppConfigId(config: ConnectorConfig): string | null {
  if (config.type === "github" && config.authMethod === "github_app") {
    return config.githubAppConfigId ?? null;
  }
  return null;
}

async function resolveGithubAppCredentials(params: {
  githubAppConfigId: string;
  organizationId: string;
  uncached: boolean;
}): Promise<ConnectorCredentials> {
  const appConfig = await GithubAppConfigModel.findByIdForOrganization({
    id: params.githubAppConfigId,
    organizationId: params.organizationId,
  });
  if (!appConfig) {
    throw new ApiError(404, "GitHub App configuration not found");
  }

  return {
    apiToken: await readSecretApiToken(appConfig.secretId, params.uncached),
    githubApp: {
      githubUrl: appConfig.githubUrl,
      appId: appConfig.appId,
      installationId: appConfig.installationId,
    },
  };
}

async function loadSecretCredentials(
  secretId: string | null,
  uncached: boolean,
): Promise<ConnectorCredentials> {
  const secret = await getSecretOrThrow(secretId, uncached);
  const data = secret.secret as Record<string, unknown>;
  const googleOAuth = resolveGoogleOAuthCredential(data);
  return {
    email: (data.email as string) || "",
    apiToken: (data.apiToken as string) || "",
    // Atlassian org-admin API key for the admin/Directory APIs; without it
    // the admin email resolver falls back to the apiToken and gets rejected.
    ...(data.adminApiKey ? { adminApiKey: data.adminApiKey as string } : {}),
    ...(googleOAuth ? { googleOAuth } : {}),
  };
}

/**
 * Pair a stored Google refresh token with the deployment's OAuth client.
 *
 * Only the token and the id of the client that issued it are stored; the
 * secret is read from configuration every time, so rotating just the secret
 * does not mean reconnecting every connector. A changed client *id* is a
 * different matter — a refresh token is bound to the client it was issued to —
 * so that mismatch is named here rather than surfacing later as an opaque
 * `invalid_grant` in the middle of a sync.
 */
function resolveGoogleOAuthCredential(
  data: Record<string, unknown>,
): ConnectorCredentials["googleOAuth"] {
  const stored = data.googleOAuth;
  if (!stored || typeof stored !== "object") return undefined;

  const { clientId, refreshToken } = stored as {
    clientId?: unknown;
    refreshToken?: unknown;
  };

  const deploymentClient = getGoogleDriveOAuthClient();
  if (!deploymentClient) {
    throw new ApiError(
      400,
      "This deployment has no Google OAuth client configured. Set ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_ID and ARCHESTRA_KNOWLEDGE_BASE_GOOGLE_DRIVE_OAUTH_CLIENT_SECRET.",
    );
  }
  if (typeof clientId === "string" && clientId !== deploymentClient.clientId) {
    throw new ApiError(
      400,
      "This connector was authorized against a different Google OAuth client than the one now configured. Reconnect its Google account.",
    );
  }

  return {
    clientId: deploymentClient.clientId,
    clientSecret: deploymentClient.clientSecret,
    ...(typeof refreshToken === "string" && refreshToken
      ? { refreshToken }
      : {}),
  };
}

async function readSecretApiToken(
  secretId: string | null,
  uncached: boolean,
): Promise<string> {
  const secret = await getSecretOrThrow(secretId, uncached);
  const data = secret.secret as Record<string, unknown>;
  return (data.apiToken as string) || "";
}

async function getSecretOrThrow(secretId: string | null, uncached: boolean) {
  if (!secretId) {
    throw new ApiError(400, "Connector has no associated credentials");
  }
  const secret = await secretManager().getSecret(secretId, {
    skipCache: uncached,
  });
  if (!secret) {
    throw new ApiError(404, "Connector credentials not found");
  }
  return secret;
}
