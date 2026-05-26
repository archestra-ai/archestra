export interface ShareInstallStep {
  label: string;
  code?: string;
  language?: "bash" | "text";
  body?: string;
}

export interface ShareClient {
  id: "claude-code" | "codex";
  label: string;
  sub: string;
  getInstallSteps: (params: ShareInstallParams) => ShareInstallStep[];
}

export interface ShareInstallParams {
  cloneUrl: string;
  marketplaceName: string;
  skillSlug: string;
}

export const SHARE_CLIENTS: ShareClient[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    sub: "Anthropic CLI",
    getInstallSteps: ({ cloneUrl, marketplaceName, skillSlug }) => [
      {
        label: "Register the marketplace",
        code: `claude plugin marketplace add ${cloneUrl}`,
        language: "bash",
      },
      {
        label: "Install the skill plugin",
        code: `/plugin install ${skillSlug}@${marketplaceName}`,
        language: "bash",
        body: "Run this slash command inside Claude Code after the marketplace is added.",
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
        label: "Install the plugin",
        body: 'Run /plugins inside Codex and pick "Install Plugin" to choose the skill you just registered.',
        code: "/plugins",
        language: "bash",
      },
    ],
  },
];

export const SHARE_TTL_PRESETS: {
  id: string;
  label: string;
  days: number | null;
}[] = [
  { id: "30d", label: "30 days", days: 30 },
  { id: "90d", label: "90 days", days: 90 },
  { id: "never", label: "Never expires", days: null },
];

export function computeExpiresAt(
  days: number | null,
  now: Date = new Date(),
): string | null {
  if (days === null) return null;
  const d = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return d.toISOString();
}
