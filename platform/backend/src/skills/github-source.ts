import { getGithubWebOrigin } from "@archestra/shared";

/** Repository and API origins travel with the credential used for skill imports. */
export interface GithubSkillSource {
  apiBaseUrl: string;
  webOrigin: string;
}

export const GITHUB_DOT_COM_SOURCE: GithubSkillSource = {
  apiBaseUrl: "https://api.github.com",
  webOrigin: "https://github.com",
};

export function githubSkillSourceFromApiUrl(
  apiBaseUrl: string,
): GithubSkillSource {
  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    webOrigin: getGithubWebOrigin(apiBaseUrl),
  };
}
