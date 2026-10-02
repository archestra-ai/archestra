"use client";

import type { ConnectClient } from "./clients";
import {
  ResourceLink,
  SkillNamesLine,
  useConnectSkills,
} from "./connect-command-panel";
import { GatewayServersSummary } from "./gateway-servers-summary";
import { SetupSummaryRow } from "./setup-summary-row";

interface ConnectionPreviewProps {
  client: ConnectClient;
  /** The gateway the approval will default to; null when none is readable. */
  gateway: { id: string; name: string } | null;
  /** Whether the approval will offer routing through the LLM Proxy. */
  proxyAvailable: boolean;
  skillsEnabled: boolean;
}

/**
 * What a prompt-connected client gets, shown before the prompt so the page
 * still says what Archestra adds: the gateway's MCP servers and tools, the LLM
 * Proxy, and shared skills. Read-only — the browser approval is where the
 * setup is customized.
 */
export function ConnectionPreview({
  client,
  gateway,
  proxyAvailable,
  skillsEnabled,
}: ConnectionPreviewProps) {
  const { eligible: skillsEligible, skills } = useConnectSkills(skillsEnabled);

  return (
    <div className="flex flex-col gap-3">
      <ul className="grid gap-2">
        {gateway && (
          <SetupSummaryRow
            detail={<GatewayServersSummary gatewayId={gateway.id} />}
          >
            Connect{" "}
            <ResourceLink href="/mcp/gateways">{gateway.name}</ResourceLink> for
            tools
          </SetupSummaryRow>
        )}
        {proxyAvailable && (
          <SetupSummaryRow done={client.id !== "cursor"}>
            {client.id === "cursor" ? (
              <span>
                Prepare <ResourceLink href="/llm/proxy">LLM Proxy</ResourceLink>{" "}
                settings for Cursor; finish setup in Cursor Settings
              </span>
            ) : (
              <span>
                Route model requests through{" "}
                <ResourceLink href="/llm/proxy">the LLM Proxy</ResourceLink>
              </span>
            )}
          </SetupSummaryRow>
        )}
        {skillsEligible && (
          <SetupSummaryRow detail={<SkillNamesLine skills={skills} />}>
            <span>Install </span>
            <ResourceLink href="/skills">
              <span>
                <span>{skills.length} shared skill</span>
                {skills.length === 1 ? null : <span>s</span>}
              </span>
            </ResourceLink>
          </SetupSummaryRow>
        )}
      </ul>
      <p className="text-xs text-muted-foreground">
        You can change these when you approve the connection in your browser.
      </p>
    </div>
  );
}
