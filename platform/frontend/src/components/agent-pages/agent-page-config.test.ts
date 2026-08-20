import { describe, expect, it } from "vitest";
import {
  agentDetailHref,
  agentEditHref,
  agentPageKindForType,
  getAgentSetupSteps,
  isAgentTypeAllowedOnPage,
  resolveAgentSetupStep,
  resolveLegacyAgentDialogRedirect,
} from "./agent-page-config";

describe("getAgentSetupSteps", () => {
  it("walks an agent through configuration, tools and advanced — connecting is the detail page's tab, not a step", () => {
    expect(
      getAgentSetupSteps({ agentType: "agent", builtIn: false }).map(
        (s) => s.id,
      ),
    ).toEqual(["configuration", "tools", "advanced"]);
  });

  it("gives an MCP gateway (and a legacy profile) the same three steps", () => {
    for (const agentType of ["mcp_gateway", "profile"] as const) {
      expect(
        getAgentSetupSteps({ agentType, builtIn: false }).map((s) => s.id),
      ).toEqual(["configuration", "tools", "advanced"]);
    }
  });

  it("skips the tools step for an LLM proxy, which has no tools", () => {
    expect(
      getAgentSetupSteps({ agentType: "llm_proxy", builtIn: false }).map(
        (s) => s.id,
      ),
    ).toEqual(["configuration", "advanced"]);
  });

  it("leaves a built-in agent with configuration only — it has no advanced step", () => {
    expect(
      getAgentSetupSteps({ agentType: "agent", builtIn: true }).map(
        (s) => s.id,
      ),
    ).toEqual(["configuration"]);
  });
});

describe("resolveAgentSetupStep", () => {
  const steps = getAgentSetupSteps({ agentType: "agent", builtIn: false });

  it("takes the step the URL names", () => {
    expect(resolveAgentSetupStep(steps, "tools")).toBe("tools");
  });

  it("falls back to the first step for a missing or unknown value", () => {
    expect(resolveAgentSetupStep(steps, null)).toBe("configuration");
    expect(resolveAgentSetupStep(steps, "guardrails")).toBe("configuration");
  });

  it("does not resolve a step the record does not have", () => {
    const proxySteps = getAgentSetupSteps({
      agentType: "llm_proxy",
      builtIn: false,
    });
    expect(resolveAgentSetupStep(proxySteps, "tools")).toBe("configuration");
  });
});

describe("route families", () => {
  it("sends each stored type to its own family, legacy profiles to gateways", () => {
    expect(agentPageKindForType("agent")).toBe("agent");
    expect(agentPageKindForType("llm_proxy")).toBe("llm_proxy");
    expect(agentPageKindForType("mcp_gateway")).toBe("mcp_gateway");
    expect(agentPageKindForType("profile")).toBe("mcp_gateway");
  });

  it("lets a legacy profile render under both the gateway and proxy pages", () => {
    expect(isAgentTypeAllowedOnPage("mcp_gateway", "profile")).toBe(true);
    expect(isAgentTypeAllowedOnPage("llm_proxy", "profile")).toBe(true);
    expect(isAgentTypeAllowedOnPage("agent", "profile")).toBe(false);
  });

  it("refuses a proxy under the gateway pages and vice versa", () => {
    expect(isAgentTypeAllowedOnPage("mcp_gateway", "llm_proxy")).toBe(false);
    expect(isAgentTypeAllowedOnPage("llm_proxy", "mcp_gateway")).toBe(false);
    expect(isAgentTypeAllowedOnPage("agent", "agent")).toBe(true);
  });

  it("builds the detail and edit hrefs off the family's list route", () => {
    expect(agentDetailHref("llm_proxy", "p1")).toBe("/llm/proxies/p1");
    expect(agentDetailHref("llm_proxy", "p1", "connect")).toBe(
      "/llm/proxies/p1?tab=connect",
    );
    expect(agentEditHref("mcp_gateway", "g1")).toBe("/mcp/gateways/g1/edit");
    expect(agentEditHref("agent", "a 1", "tools")).toBe(
      "/agents/a%201/edit?step=tools",
    );
  });
});

describe("resolveLegacyAgentDialogRedirect", () => {
  it("forwards the create dialog's ?create=true to the wizard", () => {
    expect(
      resolveLegacyAgentDialogRedirect(
        "agent",
        new URLSearchParams("create=true"),
      ),
    ).toBe("/agents/new");
  });

  it("forwards ?edit=<id> to the edit page, keeping the tools-picker request", () => {
    expect(
      resolveLegacyAgentDialogRedirect(
        "mcp_gateway",
        new URLSearchParams("edit=g1"),
      ),
    ).toBe("/mcp/gateways/g1/edit");
    expect(
      resolveLegacyAgentDialogRedirect(
        "mcp_gateway",
        new URLSearchParams("edit=g1&openTools=true"),
      ),
    ).toBe("/mcp/gateways/g1/edit?step=tools&openTools=true");
  });

  it("forwards ?view=<id> to the detail page", () => {
    expect(
      resolveLegacyAgentDialogRedirect("agent", new URLSearchParams("view=a1")),
    ).toBe("/agents/a1");
  });

  it("carries the list's own params across, dropping only what it consumed", () => {
    expect(
      resolveLegacyAgentDialogRedirect(
        "agent",
        new URLSearchParams("edit=x&name=foo&page=2"),
      ),
    ).toBe("/agents/x/edit?name=foo&page=2");
    expect(
      resolveLegacyAgentDialogRedirect(
        "agent",
        new URLSearchParams("edit=x&openTools=true&name=foo"),
      ),
    ).toBe("/agents/x/edit?step=tools&openTools=true&name=foo");
    expect(
      resolveLegacyAgentDialogRedirect(
        "mcp_gateway",
        new URLSearchParams("view=g1&labels=team%3Aops"),
      ),
    ).toBe("/mcp/gateways/g1?labels=team%3Aops");
    expect(
      resolveLegacyAgentDialogRedirect(
        "llm_proxy",
        new URLSearchParams("create=true&scope=personal"),
      ),
    ).toBe("/llm/proxies/new?scope=personal");
  });

  it("leaves table filters alone", () => {
    expect(
      resolveLegacyAgentDialogRedirect(
        "llm_proxy",
        new URLSearchParams("name=foo&scope=personal&create=false"),
      ),
    ).toBeNull();
  });
});
