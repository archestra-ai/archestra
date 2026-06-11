"use client";

import {
  providerDisplayNames,
  type SupportedProvider,
} from "@archestra/shared";
import {
  Check,
  CircleDashed,
  Loader2,
  RotateCcw,
  Terminal,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type CreateConnectionSetupBody,
  type CreateConnectionSetupResult,
  useCreateConnectionSetup,
} from "@/lib/connection-setup.query";
import type { ConnectClient } from "./clients";
import { useConnectSkills } from "./connect-skills-step";
import { fetchAllSkillIds } from "./skills-marketplace-step";
import { StepCard } from "./step-card";
import { TerminalBlock } from "./terminal-block";

type ScriptClientId = CreateConnectionSetupBody["clientId"];
export type ConnectProxyAuth = NonNullable<
  CreateConnectionSetupBody["proxyAuth"]
>;

const SCRIPT_CLIENT_IDS: readonly string[] = [
  "claude-code",
  "codex",
  "copilot-cli",
  "cursor",
] satisfies ScriptClientId[];

/** Clients whose whole setup is delivered as a single `curl | bash` command. */
export function isScriptClient(
  clientId: string | null,
): clientId is ScriptClientId {
  return clientId !== null && SCRIPT_CLIENT_IDS.includes(clientId);
}

interface ConnectCommandStepProps {
  client: ConnectClient;
  baseUrl: string;
  /** null when the MCP step is hidden or no gateway is available. */
  mcpGateway: { id: string; name: string } | null;
  /** null when the proxy step is hidden, no proxy available, or no provider picked. */
  llmProxy: { id: string; name: string; provider: SupportedProvider } | null;
  proxyAuth: ConnectProxyAuth;
  /**
   * True when a proxy is available but no provider is selected yet, so it
   * would be silently omitted from the command — prompt the user to pick one.
   */
  proxyNeedsProvider: boolean;
  /** Skills opt-in is chosen in the dedicated skills step above. */
  includeSkills: boolean;
  expanded: boolean;
  onToggle: (() => void) | undefined;
}

export function ConnectCommandStep({
  client,
  baseUrl,
  mcpGateway,
  llmProxy,
  proxyAuth,
  proxyNeedsProvider,
  includeSkills,
  expanded,
  onToggle,
}: ConnectCommandStepProps) {
  const { eligible: skillsEligible, totalSkills } = useConnectSkills();
  const includeSkillsEffective = includeSkills && skillsEligible;

  const [result, setResult] = useState<CreateConnectionSetupResult | null>(
    null,
  );
  const createSetup = useCreateConnectionSetup();

  const hasAnything = Boolean(mcpGateway || llmProxy || includeSkillsEffective);

  const handleGenerate = useCallback(async () => {
    if (!isScriptClient(client.id)) return;

    let skills: CreateConnectionSetupBody["skills"];
    if (includeSkillsEffective) {
      const skillIds = await fetchAllSkillIds();
      if (skillIds.length === 0) return;
      // The marketplace link the client clones from must outlive the one-time
      // setup token, so it never expires — admins revoke it from the Skills
      // page when needed.
      skills = { skillIds, ttlDays: null };
    }

    const created = await createSetup.mutateAsync({
      clientId: client.id,
      baseUrl,
      mcpGatewayId: mcpGateway?.id,
      llmProxyId: llmProxy?.id,
      provider: llmProxy?.provider,
      proxyAuth,
      skills,
    });
    if (created) setResult(created);
  }, [
    client.id,
    baseUrl,
    mcpGateway,
    llmProxy,
    proxyAuth,
    includeSkillsEffective,
    createSetup,
  ]);

  return (
    <StepCard
      hideStatus
      title="Run one command to connect everything"
      state={expanded ? "active" : "todo"}
      expanded={expanded}
      onToggle={onToggle}
    >
      <div className="flex flex-col gap-4">
        <SetupSummary
          client={client}
          mcpGateway={mcpGateway}
          llmProxy={llmProxy}
          proxyAuth={proxyAuth}
          proxyNeedsProvider={proxyNeedsProvider}
          includeSkills={includeSkillsEffective}
          totalSkills={totalSkills}
        />

        {result ? (
          <div className="flex flex-col gap-3">
            <TerminalBlock code={result.command} />
            <p className="text-xs text-muted-foreground">
              This command works once and expires in 15 minutes. The script it
              fetches contains your credentials — don't share it. Re-running the
              script on the same machine is safe.
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                onClick={handleGenerate}
                disabled={createSetup.isPending}
                data-testid="connect-regenerate-command"
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                {createSetup.isPending ? "Generating…" : "Generate new command"}
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button
              type="button"
              onClick={handleGenerate}
              disabled={!hasAnything || createSetup.isPending}
              data-testid="connect-generate-command"
            >
              {createSetup.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Terminal className="mr-2 h-4 w-4" />
              )}
              {createSetup.isPending ? "Generating…" : "Generate setup command"}
            </Button>
          </div>
        )}
      </div>
    </StepCard>
  );
}

// ===================================================================
// Internal pieces
// ===================================================================

function SetupSummary({
  client,
  mcpGateway,
  llmProxy,
  proxyAuth,
  proxyNeedsProvider,
  includeSkills,
  totalSkills,
}: {
  client: ConnectClient;
  mcpGateway: { id: string; name: string } | null;
  llmProxy: { id: string; name: string; provider: SupportedProvider } | null;
  proxyAuth: ConnectProxyAuth;
  proxyNeedsProvider: boolean;
  includeSkills: boolean;
  totalSkills: number;
}) {
  const rows: string[] = [];
  if (mcpGateway) {
    rows.push(
      `Register the "${mcpGateway.name}" MCP gateway in ${client.label} (OAuth — no tokens to copy)`,
    );
  }
  if (llmProxy) {
    rows.push(
      proxyAuth === "virtual-key"
        ? `Route ${providerDisplayNames[llmProxy.provider]} traffic through the "${llmProxy.name}" LLM proxy using a personal virtual key created for you`
        : `Route ${providerDisplayNames[llmProxy.provider]} traffic through the "${llmProxy.name}" LLM proxy — you keep using your own ${providerDisplayNames[llmProxy.provider]} credentials`,
    );
  }
  if (includeSkills) {
    rows.push(
      `Install the shared skills marketplace (${totalSkills} skill${totalSkills === 1 ? "" : "s"})`,
    );
  }

  if (rows.length === 0 && !proxyNeedsProvider) {
    return (
      <p className="text-sm text-muted-foreground">
        Pick an MCP gateway or an LLM proxy provider above — the generated
        command configures everything in one go.
      </p>
    );
  }

  return (
    <ul className="grid gap-1.5">
      {rows.map((row) => (
        <li key={row} className="flex items-start gap-2 text-sm">
          <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          <span>{row}</span>
        </li>
      ))}
      {proxyNeedsProvider && (
        <li className="flex items-start gap-2 text-sm text-muted-foreground">
          <CircleDashed className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Pick a provider in the LLM Proxy step above to also route model
            traffic through the proxy.
          </span>
        </li>
      )}
    </ul>
  );
}
