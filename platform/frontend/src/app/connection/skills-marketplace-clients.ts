/**
 * Builders for the Claude Code / Codex install snippets shown inside the
 * Skills marketplace step. The two snippets share a `cloneUrl` +
 * `marketplaceName` produced by a single `skill_share_link` row.
 */
export interface SkillMarketplaceInstallStep {
  label: string;
  body?: string;
  code?: string;
  language?: "bash" | "text";
}

export interface SkillMarketplaceClient {
  id: "claude-code" | "codex" | "cursor" | "copilot-cli" | "opencode";
  getInstallSteps: (
    params: SkillMarketplaceInstallParams,
  ) => SkillMarketplaceInstallStep[];
}

export interface SkillMarketplaceInstallParams {
  cloneUrl: string;
  marketplaceName: string;
}

export const SKILL_MARKETPLACE_CLIENTS: SkillMarketplaceClient[] = [
  {
    id: "claude-code",
    getInstallSteps: ({ cloneUrl, marketplaceName }) => [
      {
        label: "Register the marketplace",
        code: `claude plugin marketplace add ${cloneUrl}`,
        language: "bash",
      },
      {
        label: "Install the skills plugin",
        body: "Installs the shared skills as a single plugin; they load next time you start Claude Code.",
        code: `claude plugin install ${marketplaceName}@${marketplaceName}`,
        language: "bash",
      },
    ],
  },
  {
    id: "codex",
    getInstallSteps: ({ cloneUrl }) => [
      {
        label: "Register the marketplace",
        code: `codex plugin marketplace add ${cloneUrl}`,
        language: "bash",
      },
      {
        label: "Install the skills plugin",
        body: 'Run /plugins inside Codex and pick "Install Plugin" to install the included skills.',
        code: "/plugins",
        language: "bash",
      },
    ],
  },
  {
    id: "copilot-cli",
    getInstallSteps: ({ cloneUrl, marketplaceName }) => [
      {
        label: "Register the marketplace",
        code: `copilot plugin marketplace add ${cloneUrl}`,
        language: "bash",
      },
      {
        label: "Browse and install the skills plugin",
        body: "Pick the shared plugin from the marketplace browser; Copilot installs the included skills from there.",
        code: `copilot plugin marketplace browse ${marketplaceName}`,
        language: "bash",
      },
    ],
  },
  {
    id: "cursor",
    getInstallSteps: ({ cloneUrl, marketplaceName }) => [
      {
        label: "Register the marketplace",
        body: "Open Cursor's command palette and run /add-plugin, then paste the clone URL.",
        code: `/add-plugin ${cloneUrl}`,
        language: "bash",
      },
      {
        label: "Install the skills plugin",
        body: `The included skills appear under the "${marketplaceName}" plugin entry; install it from the marketplace view.`,
        language: "text",
      },
    ],
  },
  {
    id: "opencode",
    // OpenCode has no plugin marketplace, but it loads every SKILL.md under
    // its skills folder recursively, so a plain clone there is the install.
    // "$HOME" rather than "~": the manual flow has no OS picker, and Windows
    // PowerShell expands $HOME for git.exe but leaves ~ literal.
    getInstallSteps: ({ cloneUrl, marketplaceName }) => {
      const skillsDir = `"$HOME/.config/opencode/skills/${marketplaceName}"`;
      return [
        {
          label: "Clone the marketplace into OpenCode's skills folder",
          body: "OpenCode loads the shared skills the next time it starts.",
          code: `git clone ${cloneUrl} ${skillsDir}`,
          language: "bash",
        },
        {
          label: "Pull updates",
          body: "Run this whenever the shared skills change.",
          code: `git -C ${skillsDir} pull`,
          language: "bash",
        },
      ];
    },
  },
];

export const SKILL_MARKETPLACE_TTL_PRESETS: {
  id: string;
  label: string;
  days: number | null;
}[] = [
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "never", label: "Never expires", days: null },
];

export function computeSkillMarketplaceExpiresAt(
  days: number | null,
  now: Date = new Date(),
): string | null {
  if (days === null) return null;
  const d = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}
