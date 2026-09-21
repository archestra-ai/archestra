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
