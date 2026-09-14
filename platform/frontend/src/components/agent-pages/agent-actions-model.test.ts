import { describe, expect, it } from "vitest";
import { agentAction, getAgentActionModel } from "./agent-actions-model";

describe("getAgentActionModel", () => {
  it("uses the stored legacy resource while keeping the current route family", () => {
    const model = getAgentActionModel({
      kind: "mcp_gateway",
      agent: { id: "legacy", agentType: "profile", builtIn: false },
    });

    expect(agentAction(model, "connect")).toMatchObject({
      label: "Connect",
      // Connect is where a gateway opens, so its bare route already is it.
      href: "/mcp/gateways/legacy",
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
    expect(connect.href).toBe("/agents/agent-1?section=connect");
  });

  it("offers Start run instead of Chat on a dedicated-runtime agent while the feature is on", () => {
    const runtimeAgent = {
      id: "agent-1",
      agentType: "agent" as const,
      builtIn: false,
      runtime: { image: "ghcr.io/example/runtime" },
    };

    const withRuntime = agentAction(
      getAgentActionModel({
        kind: "agent",
        agent: runtimeAgent,
        agentRuntimeEnabled: true,
      }),
      "chat",
    );
    expect(withRuntime).toMatchObject({
      label: "Start run",
      startsRun: true,
      // Same composer either way: the runtime decides what sending does.
      href: "/chat/new?agent_id=agent-1",
    });

    // The composer ignores a stored runtime while the deployment feature is
    // off, so the row goes back to promising a chat.
    const featureOff = agentAction(
      getAgentActionModel({ kind: "agent", agent: runtimeAgent }),
      "chat",
    );
    expect(featureOff).toMatchObject({ label: "Chat", startsRun: false });

    const noRuntime = agentAction(
      getAgentActionModel({
        kind: "agent",
        agent: { ...runtimeAgent, runtime: null },
        agentRuntimeEnabled: true,
      }),
      "chat",
    );
    expect(noRuntime).toMatchObject({ label: "Chat", startsRun: false });
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
