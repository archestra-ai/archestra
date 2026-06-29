import GithubAppConfigModel from "@/models/github-app-config";
import { secretManager } from "@/secrets-manager";
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
  return {
    email: (data.email as string) || "",
    apiToken: (data.apiToken as string) || "",
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
