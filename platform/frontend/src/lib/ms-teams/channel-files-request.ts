// The request a platform admin hands to their Microsoft 365 admin so the
// Teams bot can read files shared in channels (Graph `Sites.Selected` plus a
// read grant on each team's SharePoint site).

/**
 * One site URL per line, trimmed to the site itself: a channel's
 * `https://contoso.sharepoint.com/sites/Engineering/Shared Documents/General`
 * becomes `https://contoso.sharepoint.com/sites/Engineering`.
 */
export function parseSharePointSites(input: string): string[] {
  const sites = new Set<string>();
  for (const line of input.split(/\s+/)) {
    try {
      const url = new URL(line.trim());
      const [kind, name] = url.pathname.split("/").filter(Boolean);
      const isTeamSite = kind === "sites" || kind === "teams";
      if (url.hostname.endsWith(".sharepoint.com") && isTeamSite && name) {
        sites.add(`https://${url.hostname}/${kind}/${name}`);
      }
    } catch {
      // not a URL; skip it
    }
  }
  return [...sites];
}

export function buildChannelFilesRequest(params: {
  appId: string;
  botName: string;
  sites: string[];
}): string {
  const { appId, botName } = params;
  const sites = params.sites.length
    ? params.sites
    : ["https://<tenant>.sharepoint.com/sites/<team>"];
  const example = sites[0];
  const exampleUrl = new URL(example.replace(/[<>]/g, ""));
  const sitePath = `${exampleUrl.hostname}:${exampleUrl.pathname}`;
  const grantBody = JSON.stringify({
    roles: ["read"],
    grantedToIdentities: [{ application: { id: appId, displayName: botName } }],
  });

  return [
    `Read-only access for our Teams bot to files in selected Teams channels`,
    ``,
    `Our Teams bot (Microsoft App ID ${appId}) needs to read files people share in these channels:`,
    ...sites.map((site) => `- ${site}`),
    ``,
    `It uses the Microsoft Graph permission Sites.Selected: the app can read these sites only. It gets no tenant-wide access, no OneDrive access, and you can revoke it per site at any time.`,
    ``,
    `1. Allow the permission (Global Administrator or Privileged Role Administrator)`,
    `   Microsoft Entra admin center > App registrations > open the app by its App ID > API permissions > Add a permission > Microsoft Graph > Application permissions > add Sites.Selected > Grant admin consent.`,
    `   On its own, this grants access to nothing.`,
    ``,
    `2. Grant read access on each site (SharePoint Administrator). Use any one option:`,
    ``,
    `   a) CLI for Microsoft 365 (https://pnp.github.io/cli-microsoft365/):`,
    ...sites.map(
      (site) =>
        `      m365 spo site apppermission add --siteUrl ${site} --appId ${appId} --permission read`,
    ),
    ``,
    `   b) Graph Explorer (https://developer.microsoft.com/graph/graph-explorer), per site:`,
    `      GET  https://graph.microsoft.com/v1.0/sites/${sitePath}?$select=id`,
    `      POST https://graph.microsoft.com/v1.0/sites/{id from the GET}/permissions`,
    `      Body: ${grantBody}`,
    ``,
    `   Your session needs Sites.FullControl.All to make this grant. Microsoft requires it to manage site permissions; it applies to your sign-in only, never to the app.`,
    ``,
    `3. Check or undo`,
    `   m365 spo site apppermission list --siteUrl <site>`,
    `   m365 spo site apppermission remove --siteUrl <site> --appId ${appId}`,
    ``,
    `Private and shared channels each have their own SharePoint site. List them separately if the bot needs them.`,
  ].join("\n");
}
