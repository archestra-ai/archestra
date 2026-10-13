"use client";

// The manual setup blocks (endpoint, MCP gateway, LLM proxy, skills) for
// apps without an installer or a prompt, such as n8n and Generic client.

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
 * - "script": apps with an installer; one terminal command, approve in the
 *   browser.
 * - "download": Claude Desktop; a downloaded installer.
 * - "prompt": other agents (Amp, Kiro, OpenClaw...); the generic prompt. The
 *   agent works out what it supports, which manual steps can't (Amp has no
 *   LLM proxy setting, for one).
 * - "manual": Generic client and n8n (anything that can't run a prompt).
 */
export type SetupMode = "script" | "download" | "prompt" | "manual";

export function setupModeFor(client: ConnectClient): SetupMode {
  if (client.id === "claude-desktop") return "download";
  if (isInstallerClientId(client.id)) return "script";
  if (usesGenericInstructions(client) && client.id !== "generic")
    return "prompt";
  return "manual";
}

/**
 * An agent on the other end can read a prompt (the starter and cleanup
 * prompts). Generic client is set up by hand but is still an agent; n8n isn't.
 */
export function readsPrompts(client: ConnectClient): boolean {
  return setupModeFor(client) !== "manual" || client.id === "generic";
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
