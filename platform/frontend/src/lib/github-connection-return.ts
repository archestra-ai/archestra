export function rememberGitHubConnectionReturn(
  state: string,
  pathname: string,
) {
  try {
    window.sessionStorage.setItem(
      `${storagePrefix}${state}`,
      pathname === organizationCredentials
        ? organizationCredentials
        : personalConnections,
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
    return destination === organizationCredentials
      ? organizationCredentials
      : personalConnections;
  } catch {
    return personalConnections;
  }
}

const personalConnections = "/account/connections";
const organizationCredentials = "/settings/credentials";
const storagePrefix = "github-connection-return:";
