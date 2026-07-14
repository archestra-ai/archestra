import { describe, expect, it } from "vitest";
import {
  summarizeLlmClientAccess,
  summarizeMcpClientAccess,
} from "./oauth-client-access-summary";

const AGENTS = [
  { id: "gw-1", name: "prod-gateway", agentType: "mcp_gateway" },
  { id: "gw-2", name: "staging-gateway", agentType: "mcp_gateway" },
  { id: "ag-1", name: "marketing-agent", agentType: "agent" },
  { id: "ag-2", name: "support-agent", agentType: "agent" },
];

const PROXIES = [
  { id: "px-1", name: "default-proxy", agentType: "llm_proxy" },
  { id: "px-2", name: "eu-proxy", agentType: "llm_proxy" },
];

describe("summarizeMcpClientAccess", () => {
  it("splits counts by resource type and lists names", () => {
    expect(
      summarizeMcpClientAccess({
        grantType: "client_credentials",
        allowedGatewayIds: ["gw-1", "gw-2", "ag-1"],
        agents: AGENTS,
      }),
    ).toEqual({
      primary: "2 MCP gateways · 1 agent",
      secondary: "prod-gateway, staging-gateway, marketing-agent",
    });
  });

  it("uses singular forms for single resources", () => {
    expect(
      summarizeMcpClientAccess({
        grantType: "client_credentials",
        allowedGatewayIds: ["gw-1"],
        agents: AGENTS,
      }),
    ).toEqual({
      primary: "1 MCP gateway",
      secondary: "prod-gateway",
    });
  });

  it("counts IDs the viewer cannot resolve as others and folds them into +N more", () => {
    expect(
      summarizeMcpClientAccess({
        grantType: "client_credentials",
        allowedGatewayIds: ["gw-1", "unknown-1", "unknown-2"],
        agents: AGENTS,
      }),
    ).toEqual({
      primary: "1 MCP gateway · 2 others",
      secondary: "prod-gateway +2 more",
    });
  });

  it("truncates long name lists", () => {
    expect(
      summarizeMcpClientAccess({
        grantType: "client_credentials",
        allowedGatewayIds: ["gw-1", "gw-2", "ag-1", "ag-2"],
        agents: AGENTS,
      }),
    ).toEqual({
      primary: "2 MCP gateways · 2 agents",
      secondary: "prod-gateway, staging-gateway, marketing-agent +1 more",
    });
  });

  it("describes authorization-code clients as the user's own access", () => {
    expect(
      summarizeMcpClientAccess({
        grantType: "authorization_code",
        allowedGatewayIds: [],
        agents: AGENTS,
      }),
    ).toEqual({
      primary: "Each signed-in user's access",
      secondary: null,
    });
  });

  it("shows extra grants on authorization-code clients", () => {
    expect(
      summarizeMcpClientAccess({
        grantType: "authorization_code",
        allowedGatewayIds: ["gw-1"],
        agents: AGENTS,
      }),
    ).toEqual({
      primary: "Each signed-in user's access",
      secondary: "+ grant: prod-gateway",
    });
  });

  it("falls back to a plain count when no granted resource resolves", () => {
    expect(
      summarizeMcpClientAccess({
        grantType: "authorization_code",
        allowedGatewayIds: ["unknown-1", "unknown-2"],
        agents: AGENTS,
      }),
    ).toEqual({
      primary: "Each signed-in user's access",
      secondary: "+ grant: 2 resources",
    });
  });
});

describe("summarizeLlmClientAccess", () => {
  it("counts proxies and appends names and the provider-key summary", () => {
    expect(
      summarizeLlmClientAccess({
        grantType: "client_credentials",
        allowedLlmProxyIds: ["px-1", "px-2"],
        proxies: PROXIES,
        providerKeySummary: "Gemini, Mistral AI",
      }),
    ).toEqual({
      primary: "2 LLM proxies",
      secondary: "default-proxy, eu-proxy · keys: Gemini, Mistral AI",
    });
  });

  it("uses the singular form and omits an absent provider-key summary", () => {
    expect(
      summarizeLlmClientAccess({
        grantType: "client_credentials",
        allowedLlmProxyIds: ["px-1"],
        proxies: PROXIES,
        providerKeySummary: null,
      }),
    ).toEqual({
      primary: "1 LLM proxy",
      secondary: "default-proxy",
    });
  });

  it("shows extra grants on authorization-code clients", () => {
    expect(
      summarizeLlmClientAccess({
        grantType: "authorization_code",
        allowedLlmProxyIds: ["px-2"],
        proxies: PROXIES,
        providerKeySummary: null,
      }),
    ).toEqual({
      primary: "Each signed-in user's access",
      secondary: "+ grant: eu-proxy",
    });
  });
});
