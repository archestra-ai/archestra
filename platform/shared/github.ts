/** The API root of GitHub.com, as a GitHub App definition records it. */
export const GITHUB_COM_API_URL = "https://api.github.com";

export function getGithubWebOrigin(apiBaseUrl = GITHUB_COM_API_URL): string {
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
  if (url.hostname === "github.com") return GITHUB_COM_API_URL;
  if (/\.ghe\.com$/.test(url.hostname))
    return `${url.protocol}//api.${url.host}`;
  return `${url.origin}/api/v3`;
}

/**
 * A GitHub account as a person types it: a bare login (on github.com), or its
 * address on any GitHub host (github.com, a GitHub Enterprise Server host, or
 * a ghe.com subdomain). The web base is the address's origin and the login
 * its first path segment; anything after that is ignored. Null when the input
 * names no account.
 */
export function parseGithubAccountInput(
  input: string,
): { web: string; api: string; login: string; dotCom: boolean } | null {
  const value = input.trim();
  const from = (origin: string, login: string) => {
    const api = getGithubApiBaseUrl(origin);
    return {
      web: getGithubWebOrigin(api),
      api,
      login,
      dotCom: api === "https://api.github.com",
    };
  };
  if (GITHUB_LOGIN.test(value)) return from("https://github.com", value);
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`,
    );
  } catch {
    return null;
  }
  const login = url.pathname.split("/").filter(Boolean)[0] ?? "";
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname.includes(".") ||
    !GITHUB_LOGIN.test(login)
  )
    return null;
  return from(url.origin, login);
}

/** What to say when `parseGithubAccountInput` finds no account. */
export const GITHUB_ACCOUNT_INPUT_INVALID =
  "Enter an organization name or its GitHub address.";

const GITHUB_LOGIN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
