export function getGithubWebOrigin(
  apiBaseUrl = "https://api.github.com",
): string {
  const webUrl = new URL(apiBaseUrl);
  if (webUrl.hostname === "api.github.com") {
    webUrl.hostname = "github.com";
  } else if (/^api\..+\.ghe\.com$/.test(webUrl.hostname)) {
    webUrl.hostname = webUrl.hostname.slice(4);
  }
  return webUrl.origin;
}

/**
 * The API base for a GitHub web origin: github.com, GHE.com data residency
 * (`api.<tenant>.ghe.com`), or GitHub Enterprise Server (`<origin>/api/v3`).
 */
export function getGithubApiBaseUrl(webOrigin = "https://github.com"): string {
  const url = new URL(webOrigin);
  if (url.hostname === "github.com") return "https://api.github.com";
  if (/\.ghe\.com$/.test(url.hostname))
    return `${url.protocol}//api.${url.host}`;
  return `${url.origin}/api/v3`;
}
