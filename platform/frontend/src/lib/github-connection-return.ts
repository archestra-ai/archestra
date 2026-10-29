export function rememberGitHubConnectionReturn(
  state: string,
  returnTo: string,
) {
  try {
    window.sessionStorage.setItem(
      `${storagePrefix}${state}`,
      validatedDestination(returnTo),
    );
  } catch {
    // Sign-in still works when browser storage is unavailable.
  }
}

export function consumeGitHubConnectionReturn(state: string | null) {
  if (!state) return personalCredentials;
  try {
    const key = `${storagePrefix}${state}`;
    const destination = window.sessionStorage.getItem(key);
    window.sessionStorage.removeItem(key);
    return validatedDestination(destination);
  } catch {
    return personalCredentials;
  }
}

const personalCredentials = "/account/credentials";
const accountPath = "/account";
const organizationCredentials = "/settings/credentials";
const storagePrefix = "github-connection-return:";

function validatedDestination(destination: string | null): string {
  if (!destination?.startsWith("/")) return personalCredentials;
  try {
    const url = new URL(destination, window.location.origin);
    if (url.origin !== window.location.origin) return personalCredentials;
    // Credentials used to be a section of `/account`, so a connect started
    // before it moved to its own tab recorded that page. Send it to the tab.
    if (url.pathname === accountPath)
      return `${personalCredentials}${url.search}`;
    if (
      url.pathname === personalCredentials ||
      url.pathname === organizationCredentials ||
      /^\/agents\/[a-zA-Z0-9-]+$/.test(url.pathname) ||
      url.pathname === "/chat" ||
      url.pathname.startsWith("/chat/")
    )
      return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    // Unknown or malformed destinations fall back to personal credentials.
  }
  return personalCredentials;
}
