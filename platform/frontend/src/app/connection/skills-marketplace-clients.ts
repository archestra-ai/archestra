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
  id: "claude-code" | "codex";
  label: string;
  sub: string;
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
    label: "Claude Code",
    sub: "Anthropic CLI",
    getInstallSteps: ({ cloneUrl, marketplaceName }) => [
      {
        label: "Register the marketplace",
        code: `claude plugin marketplace add ${cloneUrl}`,
        language: "bash",
      },
      {
        label: "Browse and install skills",
        body: "Run /plugin inside Claude Code; every shared skill appears as an installable plugin.",
        code: `/plugin marketplace browse ${marketplaceName}`,
        language: "bash",
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    sub: "OpenAI CLI",
    getInstallSteps: ({ cloneUrl }) => [
      {
        label: "Register the marketplace",
        code: `codex plugin marketplace add ${cloneUrl}`,
        language: "bash",
      },
      {
        label: "Install a plugin",
        body: 'Run /plugins inside Codex and pick "Install Plugin" to choose any shared skill.',
        code: "/plugins",
        language: "bash",
      },
    ],
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
