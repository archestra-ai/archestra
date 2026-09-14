import { describe, expect, test } from "@/test";
import {
  type LlmProxyPluginError,
  LlmProxyPluginRegistry,
  type LlmProxyRequestContext,
} from "./llm-proxy-plugin";

function requestContext(requestId = "request-1"): LlmProxyRequestContext {
  return {
    requestId,
    organizationId: "organization-1",
    profileId: "profile-1",
    provider: "openai",
    protocol: "openai:chatCompletions",
    model: "gpt-test",
    headers: {},
    requestBody: {},
    session: { id: "session-1" },
    resources: new Map(),
  };
}

describe("LlmProxyPluginRegistry", () => {
  test("runs plugins in registration order and propagates rewritten calls", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    registry.register({
      id: "rewrite",
      async onSessionInit() {
        events.push("rewrite:init");
      },
      async onToolCalls(context) {
        events.push(`rewrite:${context.toolCalls[0]?.name}`);
        return {
          decision: "allow",
          toolCalls: context.toolCalls.map((call) => ({
            ...call,
            name: `checked_${call.name}`,
          })),
        };
      },
    });
    registry.register({
      id: "observe",
      async onSessionInit() {
        events.push("observe:init");
      },
      async onToolCalls(context) {
        events.push(`observe:${context.toolCalls[0]?.name}`);
      },
    });

    const context = requestContext();
    await registry.onSessionInit(context);
    const outcome = await registry.onToolCalls({
      ...context,
      toolCalls: [{ id: "call-1", name: "read_file", arguments: {} }],
    });

    expect(outcome).toEqual({
      decision: "allow",
      toolCalls: [{ id: "call-1", name: "checked_read_file", arguments: {} }],
    });
    expect(events).toEqual([
      "rewrite:init",
      "observe:init",
      "rewrite:read_file",
      "observe:checked_read_file",
    ]);
  });

  test("short-circuits a refusal and cleans initialized plugins in reverse order", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    registry.register({
      id: "first",
      async onAbort() {
        events.push("first:abort");
      },
      async onToolCalls() {
        events.push("first:tools");
      },
    });
    registry.register({
      id: "deny",
      async onAbort() {
        events.push("deny:abort");
      },
      async onToolCalls() {
        events.push("deny:tools");
        return { decision: "refuse", message: "blocked" };
      },
    });
    registry.register({
      id: "after-denial",
      async onToolCalls() {
        events.push("after-denial:tools");
      },
    });

    const context = requestContext();
    await registry.onSessionInit(context);
    const outcome = await registry.onToolCalls({ ...context, toolCalls: [] });
    await registry.onAbort(context);

    expect(outcome).toEqual({ decision: "refuse", message: "blocked" });
    expect(events).toEqual([
      "first:tools",
      "deny:tools",
      "deny:abort",
      "first:abort",
    ]);
  });

  test("dispatches verified child proxy-turn boundaries in registration order", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    registry.register({
      id: "child-observer",
      async onChildStart(context) {
        events.push(`start:${context.childSessionId}`);
      },
      async onChildEnd(context) {
        events.push(`end:${String(context.result)}`);
      },
    });

    const context = {
      ...requestContext(),
      session: { id: "child-session", parentId: "parent-session" },
    };
    await registry.onSessionInit(context);
    await registry.onChildStart({
      ...context,
      childSessionId: "child-session",
    });
    await registry.onChildEnd({
      ...context,
      childSessionId: "child-session",
      result: "proxy response",
    });
    await registry.onTurnEnd(context);

    expect(events).toEqual(["start:child-session", "end:proxy response"]);
  });

  test("fails closed and aborts earlier plugins when initialization fails", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    registry.register({
      id: "allocated-resource",
      async onSessionInit() {
        events.push("allocated:init");
      },
      async onAbort() {
        events.push("allocated:abort");
      },
    });
    registry.register({
      id: "broken-plugin",
      async onSessionInit() {
        throw new Error("unavailable");
      },
    });

    await expect(
      registry.onSessionInit(requestContext()),
    ).rejects.toMatchObject({
      name: "LlmProxyPluginError",
      pluginId: "broken-plugin",
      phase: "onSessionInit",
    } satisfies Partial<LlmProxyPluginError>);
    expect(events).toEqual(["allocated:init", "allocated:abort"]);
  });

  test("releases failed initialization state even when cleanup also fails", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    registry.register({
      id: "cleanup-failure",
      async onSessionInit() {
        events.push("cleanup:init");
      },
      async onAbort() {
        events.push("cleanup:abort");
        throw new Error("cleanup unavailable");
      },
    });
    registry.register({
      id: "init-failure",
      async onSessionInit() {
        throw new Error("init unavailable");
      },
    });

    const context = requestContext();
    await expect(registry.onSessionInit(context)).rejects.toMatchObject({
      pluginId: "init-failure",
      phase: "onSessionInit",
    } satisfies Partial<LlmProxyPluginError>);
    await expect(registry.onAbort(context)).resolves.toBeUndefined();
    expect(events).toEqual(["cleanup:init", "cleanup:abort"]);
  });

  test("does not leave a session active when turn cleanup fails", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    registry.register({
      id: "turn-failure",
      async onTurnEnd() {
        throw new Error("turn unavailable");
      },
      async onAbort() {
        events.push("abort");
        throw new Error("abort unavailable");
      },
    });

    const context = requestContext();
    await registry.onSessionInit(context);
    await expect(registry.onTurnEnd(context)).rejects.toMatchObject({
      pluginId: "turn-failure",
      phase: "onTurnEnd",
    } satisfies Partial<LlmProxyPluginError>);
    await expect(registry.onAbort(context)).resolves.toBeUndefined();
    expect(events).toEqual(["abort"]);
  });
});
