"use client";

// The manual setup blocks (endpoint, MCP gateway, LLM proxy, skills) for
// apps that cannot run the connect prompt, such as n8n.

import type { ReactNode } from "react";
import type { ConnectClient } from "./clients";
import { isInstallerClientId, usesGenericInstructions } from "./clients";
import type { ConnectPageData } from "./connect-page-data";
import { McpClientInstructions } from "./mcp-client-instructions";
import { ProxyClientInstructions } from "./proxy-client-instructions";
import {
  SkillsMarketplaceStep,
  useSkillsMarketplaceVisible,
} from "./skills-marketplace-step";

/**
 * How an app gets set up:
 * - "prompt": first-party apps; one prompt, approve in the browser.
 * - "generic-prompt": other agents (Amp, Kiro, OpenClaw...); the generic
 *   prompt only. The agent works out what it supports, which manual steps
 *   can't (Amp has no LLM proxy setting, for one).
 * - "prompt-or-manual": Generic client; the generic prompt by default,
 *   manual setup one toggle away.
 * - "manual": n8n (and anything that can't run a prompt); manual only.
 */
export type SetupMode =
  | "prompt"
  | "generic-prompt"
  | "prompt-or-manual"
  | "manual";

export function setupModeFor(client: ConnectClient): SetupMode {
  if (isInstallerClientId(client.id)) return "prompt";
  if (usesGenericInstructions(client))
    return client.id === "generic" ? "prompt-or-manual" : "generic-prompt";
  return "manual";
}

export interface ManualStep {
  key: string;
  title: string;
  content: ReactNode;
}

/**
 * The manual setup as titled blocks, from what the Connect page already
 * read, so both agree on the gateway, endpoint and parts.
 */
export function useManualSteps(
  client: ConnectClient | null,
  data: ConnectPageData,
): ManualStep[] {
  const marketplaceVisible = useSkillsMarketplaceVisible(client);
  const skillsVisible = data.skillsEnabled && marketplaceVisible;
  const gateway = data.gateway;
  const baseUrl = data.baseUrl;

  if (!client) return [];
  const steps: ManualStep[] = [];
  if (data.partsFor(client).tools && gateway) {
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
  if (data.llmProxyId) {
    steps.push({
      key: "proxy",
      title: "Route model requests through the LLM proxy",
      content: (
        <ProxyClientInstructions
          client={client}
          profileId={data.llmProxyId}
          shownProviders={data.shownProviders}
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
