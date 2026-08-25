import { describe, expect, it } from "vitest";
import {
  type AgentUsage,
  agentOwnerLabel,
  agentTypeLabel,
  deriveAgentUsage,
} from "./mcp-server-agent-usage";

type ApiAgent = Omit<AgentUsage, "access">;

const agent = (overrides: Partial<ApiAgent> = {}): ApiAgent => ({
  id: "a1",
  name: "Agent",
  agentType: "agent",
  scope: "org",
  ownerId: null,
  ownerEmail: null,
  ...overrides,
});

describe("deriveAgentUsage", () => {
  it("dedupes an agent assigned tools from several installs of the catalog", () => {
    const shared = agent({ id: "a1", name: "Support Bot" });

    const usage = deriveAgentUsage({
      serversForCatalog: [
        { assignedAgents: [shared] },
        { assignedAgents: [shared] },
      ],
      autoModeAgents: [],
    });

    expect(usage.assigned).toHaveLength(1);
    expect(usage.total).toBe(1);
  });

  it("applies the org-wide auto-mode roster fetched once for all installs", () => {
    const auto = agent({ id: "auto1", name: "Auto Agent" });

    const usage = deriveAgentUsage({
      serversForCatalog: [{ assignedAgents: [] }, { assignedAgents: [] }],
      autoModeAgents: [auto],
    });

    expect(usage.autoOnly).toHaveLength(1);
    expect(usage.total).toBe(1);
  });

  it("counts an agent that is both auto-mode and explicitly assigned only once, as assigned", () => {
    const both = agent({ id: "a1", name: "Hybrid" });

    const usage = deriveAgentUsage({
      serversForCatalog: [{ assignedAgents: [both] }],
      autoModeAgents: [both],
    });

    expect(usage.assigned.map((a) => a.id)).toEqual(["a1"]);
    expect(usage.autoOnly).toEqual([]);
    expect(usage.total).toBe(1);
  });

  it("tags each agent with how it reaches the server", () => {
    const usage = deriveAgentUsage({
      serversForCatalog: [
        { assignedAgents: [agent({ id: "a1", name: "Pinned" })] },
      ],
      autoModeAgents: [agent({ id: "a2", name: "Roaming" })],
    });

    expect(usage.all.map((a) => [a.name, a.access])).toEqual([
      ["Pinned", "assigned"],
      ["Roaming", "auto"],
    ]);
  });

  it("orders same-named personal agents deterministically by owner", () => {
    const usage = deriveAgentUsage({
      serversForCatalog: [
        {
          assignedAgents: [
            agent({
              id: "b",
              name: "My Assistant",
              scope: "personal",
              ownerEmail: "zoe@example.com",
            }),
            agent({
              id: "a",
              name: "My Assistant",
              scope: "personal",
              ownerEmail: "adam@example.com",
            }),
          ],
        },
      ],
      autoModeAgents: [],
    });

    expect(usage.assigned.map((a) => a.ownerEmail)).toEqual([
      "adam@example.com",
      "zoe@example.com",
    ]);
  });

  it("returns an empty result for a catalog item nothing uses", () => {
    expect(
      deriveAgentUsage({ serversForCatalog: [], autoModeAgents: undefined })
        .total,
    ).toBe(0);
    expect(
      deriveAgentUsage({
        serversForCatalog: [{ assignedAgents: [] }],
        autoModeAgents: [],
      }).all,
    ).toEqual([]);
  });
});

describe("agentOwnerLabel", () => {
  it("attributes personal agents to their owner", () => {
    expect(
      agentOwnerLabel({ scope: "personal", ownerEmail: "kim@example.com" }),
    ).toBe("kim@example.com");
  });

  it("leaves org and team agents unqualified", () => {
    expect(
      agentOwnerLabel({ scope: "org", ownerEmail: "kim@example.com" }),
    ).toBeNull();
    expect(
      agentOwnerLabel({ scope: "team", ownerEmail: "kim@example.com" }),
    ).toBeNull();
  });

  it("has no owner to show when the author was deleted", () => {
    expect(agentOwnerLabel({ scope: "personal", ownerEmail: null })).toBeNull();
  });
});

describe("agentTypeLabel", () => {
  it("names each agent kind", () => {
    expect(agentTypeLabel("mcp_gateway")).toBe("MCP Gateway");
    expect(agentTypeLabel("llm_proxy")).toBe("LLM Proxy");
    expect(agentTypeLabel("agent")).toBe("Agent");
  });

  it("falls back for the legacy profile type", () => {
    expect(agentTypeLabel("profile")).toBe("Agent");
  });
});
