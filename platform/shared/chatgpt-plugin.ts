const DEFAULT_LOGO =
  '<svg width="32" height="32" viewBox="-0.55 -1.05 22 22" xmlns="http://www.w3.org/2000/svg">\n  <path d="M13.8357 1.67009C13.3507 0.643397 12.3441 0 11.2049 0C10.0656 0 9.05908 0.638834 8.5741 1.67009L7.02765 4.96463C6.6113 5.84987 6.6113 6.86288 7.02307 7.74812L8.39566 10.6822C8.51919 10.9514 8.50089 11.248 8.34076 11.4944C8.18062 11.7454 7.91983 11.8868 7.62243 11.8868H5.86552C4.58902 11.8868 3.41774 12.6306 2.87786 13.7805L0 19.8951H2.6857L5.07857 14.8118C5.22041 14.5106 5.53153 14.3144 5.86552 14.3144H7.62243C8.74796 14.3144 9.78197 13.7486 10.3905 12.7995C10.9944 11.8503 11.0722 10.6776 10.5964 9.66005L9.22379 6.72599C9.11398 6.49327 9.11398 6.22404 9.22379 5.99132L10.7702 2.69679C10.8755 2.4732 11.0631 2.423 11.2003 2.423C11.3376 2.423 11.5252 2.46863 11.6304 2.69679L18.26 16.7967C18.3606 17.0112 18.2737 17.1846 18.2325 17.253C18.1914 17.3169 18.0678 17.4721 17.8299 17.4721H10.1754V19.8996H17.8299C18.8319 19.8996 19.747 19.3977 20.2823 18.5535C20.8176 17.7094 20.8862 16.669 20.4607 15.7655L13.8311 1.66552L13.8357 1.67009Z" fill="#161412"/>\n</svg>\n';

/** Portable ChatGPT package plus the native Codex compatibility manifest. */
export function chatgptConnectionPluginFiles(params: {
  name: string;
  version: string;
  appName: string;
  gatewayUrl: string | null;
  serverName: string;
  frontendUrl: string;
  setupName: string;
  desktopConfigured?: boolean;
  logo?: string;
  /** Native clients currently omit portable MCP entries; use their compatibility manifest. */
  nativeOnly?: boolean;
}): Array<{ path: string; content: string }> {
  const {
    name,
    version,
    appName,
    gatewayUrl,
    serverName,
    frontendUrl,
    setupName,
  } = params;
  const setupPath = `skills/${setupName}/SKILL.md`;
  const tour = [
    "",
    "## Show what is connected",
    "",
    "This onboarding skill is bundled with this plugin. Do not discover or load it through gateway skill tools, guess skill names, or substitute another skill.",
    ...(gatewayUrl
      ? [
          `Before making any MCP calls, confirm that the server exactly named ${serverName}, supplied by this plugin, is available in this session. If it is unavailable, stop immediately without calling another server, including similarly named gateways. Direct the person to ${new URL("/connection?clientId=chatgpt", frontendUrl).href} to reconnect the plugin in a new conversation.`,
        ]
      : []),
    gatewayUrl
      ? `Use only the ${serverName} MCP server supplied by this plugin. List its advertised capability groups and the installed shared skills in at most 25 lines. Use tool descriptions and the installed skill catalog first; do not list skills by calling remote tools when they are already installed locally.`
      : "No gateway was selected for this setup. List the installed shared skills in at most 25 lines and explain which tools they need. Do not test or sign in to other MCP servers.",
    "A skill describes a workflow; it does not prove its required tools are available. Distinguish installed skills from callable tools.",
    "If a read-only example is useful, make at most one discovery call and one example call. If Guardrails refuses a call without a remedy, stop that lookup and explain the restriction briefly. Do not retry it through another wrapper, change policy, or call diagnostic or break-glass tools to get past it.",
    "Finish with two useful prompts based on the capabilities actually available.",
  ];
  const setup = params.desktopConfigured
    ? [
        "---",
        `name: ${JSON.stringify(setupName)}`,
        'description: "Show the tools and skills provided by this connection and verify local desktop setup."',
        "---",
        "",
        `# ${appName} connection`,
        "",
        "The approved terminal installer has installed this plugin, configured the selected local settings and checked sandbox prerequisites. Do not ask the person to repeat terminal setup or upload another ZIP. Complete gateway OAuth if still needed, then restart the desktop app before starting a new local conversation.",
        ...tour,
      ].join("\n")
    : [
        "---",
        `name: ${JSON.stringify(setupName)}`,
        'description: "Set up this gateway in ChatGPT and check local sandbox prerequisites before desktop shell commands."',
        "---",
        "",
        "# Set up the gateway",
        "",
        "Connect the gateway account through the plugin's OAuth flow. A successful gateway sign-in does not verify the local desktop sandbox.",
        "",
        "For ChatGPT web chats and dots, use the remote MCP tools and bundled skills. Do not ask people to install local Linux packages for these surfaces.",
        "",
        "For local Work or Codex tasks in the desktop app, complete the terminal setup before running shell commands. Open the connection page below, select ChatGPT, and run its desktop setup command on the computer running the app. This checks the local sandbox before changing client configuration. On Windows, use the Windows command even when the app runs Codex in WSL. Restart ChatGPT after setup.",
        "",
        new URL("/connection?clientId=chatgpt", frontendUrl).href,
        "",
        'The Windows setup checks the default WSL distribution. If the desktop project uses another distribution, set `$env:ARCHESTRA_CODEX_WSL_DISTRIBUTION = "YourDistribution"` in PowerShell before running setup. Verify the harmless command in that desktop project afterward.',
        "",
        "If Linux or WSL reports that bubblewrap is unavailable, have the person install it in that Linux environment: Ubuntu/Debian: `sudo apt install bubblewrap`; Fedora: `sudo dnf install bubblewrap`. Run these in the person's terminal, then rerun desktop setup. Do not run sudo or change system packages without their approval. Native Windows and macOS do not need this Linux package.",
        "",
        "If bubblewrap is installed but cannot create a user namespace, follow https://learn.chatgpt.com/docs/sandboxing#prerequisites. Keep sandbox and Guardrails protections enabled; do not work around a failed sandbox by switching to full access or bypassing approvals.",
        "",
        "After setup, verify one harmless local command and its exit status. A Guardrails approval alone is not proof that the command executed. If execution fails, report the actual error and repair the prerequisite before retrying.",
        ...tour,
      ].join("\n");
  const logoPath = params.logo ?? "./assets/logo.svg";
  const extension = {
    onboardingSkill: `./${setupPath}`,
    interface: {
      displayName: appName,
      shortDescription: "Your team's tools and skills",
      developerName: appName,
      category: "Productivity",
      logo: logoPath,
      composerIcon: logoPath,
    },
  };
  const nativeServers = gatewayUrl
    ? { [serverName]: { url: gatewayUrl, required: true } }
    : {};
  const portableServers = gatewayUrl
    ? {
        [serverName]: {
          type: "streamable-http",
          url: gatewayUrl,
          extensions: {
            "com.openai": { auth: { type: "oauth", client: { mode: "dcr" } } },
          },
        },
      }
    : {};
  const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
  const files = [
    {
      path: "plugin.json",
      content: json({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
        version,
        description: `MCP tools and skills from ${appName}`,
        extensions: { "com.openai": extension },
      }),
    },
    {
      path: ".codex-plugin/plugin.json",
      content: json({
        name,
        version,
        description: `MCP tools and skills from ${appName}`,
        skills: "./skills/",
        ...(gatewayUrl ? { mcpServers: "./.mcp.json" } : {}),
        interface: extension.interface,
        extensions: { "com.openai": extension },
      }),
    },
    ...(gatewayUrl
      ? [
          {
            path: "mcp.json",
            content: json({
              $schema:
                "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
              mcpServers: portableServers,
            }),
          },
          { path: ".mcp.json", content: json({ mcpServers: nativeServers }) },
        ]
      : []),
    { path: setupPath, content: setup },
    ...(!params.logo
      ? [{ path: "assets/logo.svg", content: DEFAULT_LOGO }]
      : []),
  ];
  return params.nativeOnly
    ? files.filter(
        (file) => file.path !== "plugin.json" && file.path !== "mcp.json",
      )
    : files;
}
