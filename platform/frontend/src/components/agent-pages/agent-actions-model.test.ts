import { describe, expect, it } from "vitest";
import { agentAction, getAgentActionModel } from "./agent-actions-model";

describe("getAgentActionModel", () => {
  it("uses the stored legacy resource while keeping the current route family", () => {
    const model = getAgentActionModel({
      kind: "llm_proxy",
      agent: { id: "legacy", agentType: "profile", builtIn: false },
    });

    expect(agentAction(model, "connect")).toMatchObject({
      label: "Connect",
      href: "/llm/proxies/legacy#connect",
      permissions: { agent: ["read"] },
      visible: true,
    });
    expect(agentAction(model, "edit").permissions).toEqual({
      agent: ["update"],
    });
  });

  it("keeps Connect in rows with the detail-section destination", () => {
    const connect = agentAction(
      getAgentActionModel({
        kind: "agent",
        agent: { id: "agent-1", agentType: "agent", builtIn: false },
      }),
      "connect",
    );

    expect(connect.visible).toBe(true);
    expect(connect.href).toBe("/agents/agent-1#connect");
  });

  it("removes Connect from built-in list and detail surfaces", () => {
    const model = getAgentActionModel({
      kind: "mcp_gateway",
      agent: { id: "builtin", agentType: "mcp_gateway", builtIn: true },
    });

    expect(agentAction(model, "connect").visible).toBe(false);
    expect(agentAction(model, "edit").permissions).toEqual({
      mcpGateway: ["update", "admin"],
    });
  });
});
