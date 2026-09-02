import { describe, expect, it } from "vitest";
import {
  agentConfigureHref,
  agentDetailHref,
  agentPageKindForType,
  getAgentSetupSteps,
  isAgentTypeAllowedOnPage,
  resolveAgentDetailSection,
  resolveLegacyAgentDialogRedirect,
} from "./agent-page-config";

describe("getAgentSetupSteps", () => {
  it("walks an agent through configuration, tools, messaging and advanced — connecting is the detail page's section, not a step", () => {
    expect(
      getAgentSetupSteps({ agentType: "agent", builtIn: false }).map(
        (s) => s.id,
      ),
    ).toEqual(["configuration", "tools", "messaging", "advanced"]);
  });

  // A gateway or a proxy is not something a person messages, so it gets no
  // messaging step.
  it("gives an MCP gateway (and a legacy profile) the same three steps", () => {
    for (const agentType of ["mcp_gateway", "profile"] as const) {
      expect(
        getAgentSetupSteps({ agentType, builtIn: false }).map((s) => s.id),
      ).toEqual(["configuration", "tools", "advanced"]);
    }
  });

  it("leaves a built-in agent with configuration only — it has no advanced step", () => {
    expect(
      getAgentSetupSteps({ agentType: "agent", builtIn: true }).map(
        (s) => s.id,
      ),
    ).toEqual(["configuration"]);
  });
});

describe("route families", () => {
  it("sends each stored type to its own family, legacy profiles to gateways", () => {
    expect(agentPageKindForType("agent")).toBe("agent");
    expect(agentPageKindForType("mcp_gateway")).toBe("mcp_gateway");
    expect(agentPageKindForType("profile")).toBe("mcp_gateway");
  });

  it("lets a legacy profile render under the gateway pages only", () => {
    expect(isAgentTypeAllowedOnPage("mcp_gateway", "profile")).toBe(true);
    expect(isAgentTypeAllowedOnPage("agent", "profile")).toBe(false);
  });

  it("refuses a type under another family's pages", () => {
    expect(isAgentTypeAllowedOnPage("mcp_gateway", "agent")).toBe(false);
    expect(isAgentTypeAllowedOnPage("agent", "mcp_gateway")).toBe(false);
    expect(isAgentTypeAllowedOnPage("agent", "agent")).toBe(true);
  });

  it("builds every detail section off the family's list route", () => {
    // The section a record opens on is its bare route, and that differs by
    // family: a gateway opens on Connect, an agent on its configuration.
    expect(agentDetailHref("mcp_gateway", "g1")).toBe("/mcp/gateways/g1");
    expect(agentDetailHref("mcp_gateway", "g1", "connect")).toBe(
      "/mcp/gateways/g1",
    );
    expect(agentDetailHref("mcp_gateway", "g1", "general")).toBe(
      "/mcp/gateways/g1?section=general",
    );
    expect(agentDetailHref("agent", "a1", "general")).toBe("/agents/a1");
    expect(agentDetailHref("agent", "a1", "connect")).toBe(
      "/agents/a1?section=connect",
    );
  });

  it("points every edit deep link at the detail page's own sections", () => {
    // Editing means the configuration, never wherever the page opens — a
    // gateway opens on Connect, which configures nothing.
    // A gateway configures in one Settings tab, so every step resolves there.
    expect(agentConfigureHref("mcp_gateway", "g1")).toBe(
      "/mcp/gateways/g1?section=settings",
    );
    expect(agentConfigureHref("mcp_gateway", "g1", "tools")).toBe(
      "/mcp/gateways/g1?section=settings",
    );
    expect(agentConfigureHref("agent", "a 1", "tools")).toBe(
      "/agents/a%201?section=tools",
    );
  });
});

describe("resolveAgentDetailSection", () => {
  const sections = ["general", "tools", "connect"] as const;

  it("takes the section the param names", () => {
    expect(resolveAgentDetailSection(sections, "connect")).toBe("connect");
  });

  it("falls back to the first section for one this record does not have", () => {
    // A gateway sent to `?section=executions`, or a typo: the page corrects
    // the URL to what it actually rendered rather than showing a blank pane.
    expect(resolveAgentDetailSection(sections, "executions")).toBe("general");
    expect(resolveAgentDetailSection(sections, null)).toBe("general");
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

  it("forwards ?edit=<id> to the configuration tab, keeping the tools-picker request", () => {
    expect(
      resolveLegacyAgentDialogRedirect(
        "mcp_gateway",
        new URLSearchParams("edit=g1"),
      ),
    ).toBe("/mcp/gateways/g1?section=settings");
    expect(
      resolveLegacyAgentDialogRedirect(
        "mcp_gateway",
        new URLSearchParams("edit=g1&openTools=true"),
      ),
    ).toBe("/mcp/gateways/g1?section=settings&openTools=true");
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
    ).toBe("/agents/x?name=foo&page=2");
    expect(
      resolveLegacyAgentDialogRedirect(
        "agent",
        new URLSearchParams("edit=x&openTools=true&name=foo"),
      ),
    ).toBe("/agents/x?section=tools&openTools=true&name=foo");
    expect(
      resolveLegacyAgentDialogRedirect(
        "mcp_gateway",
        new URLSearchParams("view=g1&labels=team%3Aops"),
      ),
    ).toBe("/mcp/gateways/g1?labels=team%3Aops");
    expect(
      resolveLegacyAgentDialogRedirect(
        "mcp_gateway",
        new URLSearchParams("create=true&scope=personal"),
      ),
    ).toBe("/mcp/gateways/new?scope=personal");
  });

  it("leaves table filters alone", () => {
    expect(
      resolveLegacyAgentDialogRedirect(
        "mcp_gateway",
        new URLSearchParams("name=foo&scope=personal&create=false"),
      ),
    ).toBeNull();
  });
});
