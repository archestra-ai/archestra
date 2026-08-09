import GithubAppConfigModel from "@/models/github-app-config";
import { secretManager } from "@/secrets-manager";
import { getGoogleDriveOAuthClient } from "./connectors/gdrive/gdrive-oauth";
import {
  ApiError,
  type ConnectorConfig,
  type ConnectorCredentials,
  type KnowledgeBaseConnector,
} from "@/types";

/**
 * Resolve the runtime credentials a connector authenticates with. GitHub App
 * connectors reference a shared github_app_configs row (App metadata + private
 * key secret); credentialless connectors receive an empty credential object;
 * every other connector uses its own attached secret.
 */
export async function resolveConnectorCredentials(
  connector: Pick<
    KnowledgeBaseConnector,
    "config" | "organizationId" | "secretId"
  >,
): Promise<ConnectorCredentials> {
  const githubAppConfigId = extractGithubAppConfigId(connector.config);
  if (githubAppConfigId) {
    return resolveGithubAppCredentials({
      githubAppConfigId,
      organizationId: connector.organizationId,
    });
  }

  if (connector.config.type === "web_crawler") {
    return { apiToken: "" };
  }

  return loadSecretCredentials(connector.secretId);
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
}): Promise<ConnectorCredentials> {
  const appConfig = await GithubAppConfigModel.findByIdForOrganization({
    id: params.githubAppConfigId,
    organizationId: params.organizationId,
  });
  if (!appConfig) {
    throw new ApiError(404, "GitHub App configuration not found");
  }

  return {
    apiToken: await readSecretApiToken(appConfig.secretId),
    githubApp: {
      githubUrl: appConfig.githubUrl,
      appId: appConfig.appId,
      installationId: appConfig.installationId,
    },
  };
}

async function loadSecretCredentials(
  secretId: string | null,
): Promise<ConnectorCredentials> {
  const secret = await getSecretOrThrow(secretId);
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

async function readSecretApiToken(secretId: string | null): Promise<string> {
  const secret = await getSecretOrThrow(secretId);
  const data = secret.secret as Record<string, unknown>;
  return (data.apiToken as string) || "";
}

async function getSecretOrThrow(secretId: string | null) {
  if (!secretId) {
    throw new ApiError(400, "Connector has no associated credentials");
  }
  const secret = await secretManager().getSecret(secretId);
  if (!secret) {
    throw new ApiError(404, "Connector credentials not found");
  }
  return secret;
}
