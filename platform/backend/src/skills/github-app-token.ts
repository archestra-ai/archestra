import { resolveInstallationToken } from "@/integrations/github/app-auth";
import { GithubAppConfigModel, GithubPatModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { ApiError } from "@/types";

/**
 * Read a stored GitHub personal access token (org-scoped, managed at
 * /settings/github). Shared by the interactive import route (which layers a
 * per-user RBAC check on top) and the background skill sync worker. Throws
 * `ApiError` when the token is missing; callers surface or record the message.
 */
export async function resolveGithubPatToken(params: {
  githubPatId: string;
  organizationId: string;
}): Promise<string> {
  const pat = await GithubPatModel.findByIdForOrganization({
    id: params.githubPatId,
    organizationId: params.organizationId,
  });
  if (!pat) {
    throw new ApiError(404, "GitHub token not found");
  }
  if (!pat.secretId) {
    throw new ApiError(400, "GitHub token has no stored value");
  }
  const secret = await secretManager().getSecret(pat.secretId);
  if (!secret) {
    throw new ApiError(404, "GitHub token value not found");
  }
  const token = (secret.secret as Record<string, unknown>).apiToken;
  if (typeof token !== "string" || token.length === 0) {
    throw new ApiError(400, "GitHub token has no stored value");
  }
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

  if (!appConfig.secretId) {
    throw new ApiError(
      400,
      "GitHub App configuration has no stored private key",
    );
  }
  const secret = await secretManager().getSecret(appConfig.secretId);
  if (!secret) {
    throw new ApiError(404, "GitHub App private key not found");
  }
  const privateKey =
    ((secret.secret as Record<string, unknown>).apiToken as string) || "";

  return resolveInstallationToken({
    githubUrl: appConfig.githubUrl,
    appId: appConfig.appId,
    installationId: appConfig.installationId,
    privateKey,
  });
}

function isGithubDotComUrl(url: string): boolean {
  try {
    return new URL(url).host === "api.github.com";
  } catch {
    return false;
  }
}
