import GithubAppConfigModel from "@/models/github-app-config";
import KnowledgeBaseConnectorModel from "@/models/knowledge-base-connector";
import { secretManager } from "@/secrets-manager";
import {
  ApiError,
  type CreateGithubAppConfigRequest,
  type GithubAppConfig,
  type PublicGithubAppConfig,
  type UpdateGithubAppConfigRequest,
} from "@/types";

const DEFAULT_GITHUB_URL = "https://api.github.com";

export async function listGithubAppConfigs(
  organizationId: string,
): Promise<PublicGithubAppConfig[]> {
  const configs = await GithubAppConfigModel.findByOrganization(organizationId);
  return configs.map(toPublicGithubAppConfig);
}

export async function getGithubAppConfig(params: {
  id: string;
  organizationId: string;
}): Promise<PublicGithubAppConfig> {
  return toPublicGithubAppConfig(await requireGithubAppConfig(params));
}

export async function createGithubAppConfig(params: {
  organizationId: string;
  data: CreateGithubAppConfigRequest;
}): Promise<PublicGithubAppConfig> {
  const { organizationId, data } = params;
  const secret = await secretManager().createSecret(
    { apiToken: data.privateKey },
    `github-app-${data.name}`,
  );

  const config = await GithubAppConfigModel.create({
    organizationId,
    name: data.name,
    githubUrl: data.githubUrl ?? DEFAULT_GITHUB_URL,
    appId: data.appId,
    installationId: data.installationId,
    secretId: secret.id,
  });

  return toPublicGithubAppConfig(config);
}

export async function updateGithubAppConfig(params: {
  id: string;
  organizationId: string;
  data: UpdateGithubAppConfigRequest;
}): Promise<PublicGithubAppConfig> {
  const { id, organizationId, data } = params;
  const existing = await requireGithubAppConfig({ id, organizationId });

  let secretId = existing.secretId;
  if (data.privateKey) {
    if (existing.secretId) {
      await secretManager().updateSecret(existing.secretId, {
        apiToken: data.privateKey,
      });
    } else {
      const secret = await secretManager().createSecret(
        { apiToken: data.privateKey },
        `github-app-${data.name ?? existing.name}`,
      );
      secretId = secret.id;
    }
  }

  const updated = await GithubAppConfigModel.update(id, {
    name: data.name,
    githubUrl: data.githubUrl,
    appId: data.appId,
    installationId: data.installationId,
    secretId,
  });
  if (!updated) {
    throw new ApiError(404, "GitHub App configuration not found");
  }

  return toPublicGithubAppConfig(updated);
}

export async function deleteGithubAppConfig(params: {
  id: string;
  organizationId: string;
}): Promise<void> {
  const existing = await requireGithubAppConfig(params);

  // connector references live only in JSON config, so there is no FK to guard
  // against dangling connectors — block deletion while any still point here
  const referencingConnectors =
    await KnowledgeBaseConnectorModel.countReferencingGithubAppConfig({
      githubAppConfigId: existing.id,
      organizationId: existing.organizationId,
    });
  if (referencingConnectors > 0) {
    throw new ApiError(
      409,
      `GitHub App configuration is in use by ${referencingConnectors} connector(s) and cannot be deleted`,
    );
  }

  if (existing.secretId) {
    await secretManager().deleteSecret(existing.secretId);
  }
  await GithubAppConfigModel.delete(existing.id);
}

// ===== Internal helpers =====

async function requireGithubAppConfig(params: {
  id: string;
  organizationId: string;
}): Promise<GithubAppConfig> {
  const config = await GithubAppConfigModel.findByIdForOrganization(params);
  if (!config) {
    throw new ApiError(404, "GitHub App configuration not found");
  }
  return config;
}

function toPublicGithubAppConfig(
  config: GithubAppConfig,
): PublicGithubAppConfig {
  const { secretId: _secretId, ...rest } = config;
  return rest;
}
