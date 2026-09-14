import {
  GithubAppConfigModel,
  RuntimeCredentialDefinitionModel,
} from "@/models";
import { resolveCredentialValue } from "@/services/credentials";
import { ApiError } from "@/types";

/**
 * Read a stored GitHub personal access token (org-scoped, managed at
 * /settings/credentials). Shared by the interactive import route (which layers a
 * per-user RBAC check on top) and the background skill sync worker. Throws
 * `ApiError` when the token is missing; callers surface or record the message.
 */
export async function resolveGithubPatToken(params: {
  githubPatId: string;
  organizationId: string;
}): Promise<string> {
  const definition = await RuntimeCredentialDefinitionModel.findById({
    id: params.githubPatId,
    organizationId: params.organizationId,
  });
  if (!definition || definition.kind !== "secret")
    throw new ApiError(404, "GitHub token not found");
  const token = await resolveCredentialValue({
    organizationId: params.organizationId,
    credentialId: definition.key,
    scope: "organization",
  });
  if (!token) throw new ApiError(400, "GitHub token has no stored value");
  return token;
}

/**
 * Exchange a stored GitHub App config (org-scoped, github.com only) for a
 * short-lived installation token. Shared by the interactive import route
 * (which layers a per-user RBAC check on top) and the background skill sync
 * worker (system context, no user). Throws `ApiError` when the config is
 * missing or unusable; callers surface or record the message.
 */
export async function resolveGithubAppInstallationToken(params: {
  githubAppConfigId: string;
  organizationId: string;
}): Promise<string> {
  const appConfig = await GithubAppConfigModel.findByIdForOrganization({
    id: params.githubAppConfigId,
    organizationId: params.organizationId,
  });
  if (!appConfig) {
    throw new ApiError(404, "GitHub App configuration not found");
  }
  if (!isGithubDotComUrl(appConfig.githubUrl)) {
    throw new ApiError(
      400,
      "Skill import via GitHub App is only supported for github.com",
    );
  }

  const definition = await RuntimeCredentialDefinitionModel.findById({
    id: params.githubAppConfigId,
    organizationId: params.organizationId,
  });
  if (!definition) throw new ApiError(404, "GitHub App credential not found");
  const token = await resolveCredentialValue({
    organizationId: params.organizationId,
    credentialId: definition.key,
    scope: "organization",
  });
  if (!token)
    throw new ApiError(400, "GitHub App credential has no private key");
  return token;
}

function isGithubDotComUrl(url: string): boolean {
  try {
    return new URL(url).host === "api.github.com";
  } catch {
    return false;
  }
}
