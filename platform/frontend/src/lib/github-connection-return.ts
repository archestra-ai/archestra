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
  if (!state) return personalConnections;
  try {
    const key = `${storagePrefix}${state}`;
    const destination = window.sessionStorage.getItem(key);
    window.sessionStorage.removeItem(key);
    return validatedDestination(destination);
  } catch {
    return personalConnections;
  }
}

const personalConnections = "/account/connections";
const organizationCredentials = "/settings/credentials";
const storagePrefix = "github-connection-return:";

function validatedDestination(destination: string | null): string {
  if (!destination?.startsWith("/")) return personalConnections;
  try {
    const url = new URL(destination, window.location.origin);
    if (url.origin !== window.location.origin) return personalConnections;
    if (
      url.pathname === personalConnections ||
      url.pathname === organizationCredentials ||
      /^\/agents\/[a-zA-Z0-9-]+$/.test(url.pathname) ||
      url.pathname === "/chat" ||
      url.pathname.startsWith("/chat/")
    )
      return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    // Unknown or malformed destinations fall back to personal connections.
  }
  return personalConnections;
}
