"use client";

// The manual setup blocks (endpoint, MCP gateway, LLM proxy, skills) for
// apps that cannot run the connect prompt, such as n8n.

import { type ReactNode, useMemo, useState } from "react";
import { useDefaultMcpGateway, useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import config from "@/lib/config/config";
import { useLlmProxy } from "@/lib/llm-proxy.query";
import { useOrganization } from "@/lib/organization.query";
import type { ConnectClient } from "./clients";
import { isScriptClient, usesGenericInstructions } from "./clients";
import {
  getConnectableProviders,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "./connection-flow.utils";
import { ConnectionUrlStep } from "./connection-url-step";
import { McpClientInstructions } from "./mcp-client-instructions";
import { ProxyClientInstructions } from "./proxy-client-instructions";
import {
  SkillsMarketplaceStep,
  useSkillsMarketplaceVisible,
} from "./skills-marketplace-step";

/**
 * How an app gets set up:
 * - "prompt": first-party apps; one prompt, approve in the browser.
 * - "prompt-or-manual": other agents ("Any client", Amp, Kiro, OpenClaw...);
 *   a generic prompt by default, manual setup one toggle away.
 * - "manual": n8n (and anything that can't run a prompt); manual only.
 */
export type SetupMode = "prompt" | "prompt-or-manual" | "manual";

export function setupModeFor(client: ConnectClient): SetupMode {
  if (isScriptClient(client.id)) return "prompt";
  if (usesGenericInstructions(client)) return "prompt-or-manual";
  return "manual";
}

export interface ManualStep {
  key: string;
  title: string;
  content: ReactNode;
}

/**
 * The manual setup as titled blocks, so a variant can lay them out its own way.
 * The Connect page passes its gateway and endpoint so both views agree.
 */
export function useManualSteps(
  client: ConnectClient | null,
  selection: {
    gatewayId?: string;
    baseUrl?: string;
    onBaseUrlChange?: (url: string) => void;
  } = {},
): ManualStep[] {
  const { data: org } = useOrganization(true);
  const { data: defaultGateway } = useDefaultMcpGateway();
  const gatewayId =
    selection.gatewayId ??
    org?.connectionDefaultMcpGatewayId ??
    defaultGateway?.id;
  const { data: gateway } = useProfile(gatewayId);
  const llmProxyEnabled = org?.connectionLlmProxyEnabled === true;
  const { data: llmProxy } = useLlmProxy({ enabled: llmProxyEnabled });
  const { data: canReadMcpGateway } = useHasPermissions({
    mcpGateway: ["read"],
  });
  const { data: canReadLlmProxy } = useHasPermissions({ llmProxy: ["read"] });
  const marketplaceVisible = useSkillsMarketplaceVisible(client);
  const skillsVisible =
    org?.connectionSkillsEnabled === true && marketplaceVisible;

  const candidateBaseUrls = useMemo(
    () =>
      resolveCandidateBaseUrls({
        externalProxyUrls: config.api.externalProxyUrls,
        internalProxyUrl: config.api.internalProxyUrl,
        metadata: org?.connectionBaseUrls ?? null,
      }),
    [org?.connectionBaseUrls],
  );
  const adminDefault = resolveAdminDefaultBaseUrl(
    org?.connectionBaseUrls ?? null,
  );
  const [userBaseUrl, setUserBaseUrl] = useState<string | null>(null);
  const baseUrl =
    (selection.baseUrl &&
      candidateBaseUrls.includes(selection.baseUrl) &&
      selection.baseUrl) ||
    (userBaseUrl && candidateBaseUrls.includes(userBaseUrl) && userBaseUrl) ||
    (adminDefault &&
      candidateBaseUrls.includes(adminDefault) &&
      adminDefault) ||
    candidateBaseUrls[0];

  if (!client) return [];
  const steps: ManualStep[] = [];
  if (candidateBaseUrls.length > 1) {
    steps.push({
      key: "endpoint",
      title: "Select an endpoint",
      content: (
        <ConnectionUrlStep
          bare
          candidateUrls={candidateBaseUrls}
          metadata={org?.connectionBaseUrls ?? null}
          value={baseUrl}
          onChange={selection.onBaseUrlChange ?? setUserBaseUrl}
        />
      ),
    });
  }
  if (canReadMcpGateway && gateway) {
    steps.push({
      key: "mcp",
      title: "Connect the MCP gateway",
      content: (
        <McpClientInstructions
          client={client}
          gatewayId={gateway.id}
          gatewaySlug={gateway.slug ?? gateway.id}
          gatewayName={gateway.name}
          isPersonalGateway={gateway.isPersonalGateway}
          baseUrl={baseUrl}
        />
      ),
    });
  }
  if (llmProxyEnabled && canReadLlmProxy && llmProxy?.id) {
    steps.push({
      key: "proxy",
      title: "Route model requests through the LLM proxy",
      content: (
        <ProxyClientInstructions
          client={client}
          profileId={llmProxy.id}
          shownProviders={org ? getConnectableProviders(org) : null}
          baseUrl={baseUrl}
        />
      ),
    });
  }
  if (skillsVisible) {
    steps.push({
      key: "skills",
      title: "Install shared skills",
      content: <SkillsMarketplaceStep client={client} />,
    });
  }
  return steps;
}
