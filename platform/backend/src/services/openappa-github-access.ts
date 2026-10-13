import {
  type GitAccess,
  resolveGitCredentialAccess,
} from "@/git-hosts/git-access";
import {
  resolveGithubPatToken,
  resolveGithubSkillAppCredentials,
} from "@/skills/github-app-token";
import { GITHUB_DOT_COM_SOURCE } from "@/skills/github-source";
import { ApiError } from "@/types";

/**
 * The token and GitHub origins for an OpenAPPA policy source. A GitHub App
 * carries its own API URL, so GitHub Enterprise Server works like github.com;
 * personal access tokens and public reads are github.com only.
 */
export async function resolveOpenAppaGithubAccess(source: {
  organizationId: string;
  githubPatId: string | null;
  githubAppConfigId: string | null;
}): Promise<OpenAppaGithubAccess> {
  if (source.githubAppConfigId) {
    const { githubToken, githubSource } =
      await resolveGithubSkillAppCredentials({
        organizationId: source.organizationId,
        githubAppConfigId: source.githubAppConfigId,
      });
    return {
      token: githubToken,
      api: githubSource.apiBaseUrl,
      web: githubSource.webOrigin,
    };
  }
  const origins = {
    api: GITHUB_DOT_COM_SOURCE.apiBaseUrl,
    web: GITHUB_DOT_COM_SOURCE.webOrigin,
  };
  if (source.githubPatId)
    return {
      token: await resolveGithubPatToken({
        organizationId: source.organizationId,
        githubPatId: source.githubPatId,
      }),
      ...origins,
    };
  return { token: undefined, ...origins };
}

/** The GitLab host and token behind a source's GitLab token. */
export async function resolveOpenAppaGitlabAccess(source: {
  organizationId: string;
  gitlabTokenId: string;
}): Promise<GitAccess> {
  const access = await resolveGitCredentialAccess({
    organizationId: source.organizationId,
    credentialId: source.gitlabTokenId,
  });
  if (access.host.provider !== "gitlab")
    throw new ApiError(400, "The policy source's credential is not for GitLab");
  return access;
}

type OpenAppaGithubAccess = {
  token: string | undefined;
  /** API base, e.g. https://api.github.com or https://github.example.com/api/v3. */
  api: string;
  /** Web origin, e.g. https://github.com. */
  web: string;
};
