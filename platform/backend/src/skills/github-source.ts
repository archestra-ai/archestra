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
  const apiUrl = new URL(apiBaseUrl);
  const webUrl = new URL(apiUrl.origin);
  if (apiUrl.hostname === "api.github.com") {
    webUrl.hostname = "github.com";
  } else if (/^api\..+\.ghe\.com$/.test(apiUrl.hostname)) {
    webUrl.hostname = apiUrl.hostname.slice(4);
  }
  return {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    webOrigin: webUrl.origin,
  };
}
