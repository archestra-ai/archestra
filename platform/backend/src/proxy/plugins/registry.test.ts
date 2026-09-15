import { describe, expect, test, vi } from "@/test";
import {
  type LlmProxyPlugin,
  LlmProxyPluginInitializer,
  LlmProxyPluginRegistry,
  type LlmProxyRequestContext,
} from "./registry";

function requestContext(): LlmProxyRequestContext {
  return {
    requestId: "request-1",
    organizationId: "organization-1",
    profileId: "profile-1",
    provider: "openai",
    interactionType: "openai:chatCompletions",
    model: "gpt-test",
    streaming: false,
    headers: {},
    requestBody: {},
    resources: new Map(),
  };
}

describe("LlmProxyPluginRegistry", () => {
  test("does not allocate lifecycle state or invoke callbacks when empty", async () => {
    const registry = new LlmProxyPluginRegistry();
    const context = requestContext();
    const set = vi.spyOn(Map.prototype, "set");

    await registry.onSessionInit(context);
    await registry.onPrompt({ ...context, prompt: {} });
    await registry.onBeforeModel({ ...context, request: {} });
    await expect(
      registry.onToolCalls({ ...context, toolCalls: [] }),
    ).resolves.toEqual({ decision: "allow", toolCalls: [] });
    await expect(
      registry.onToolResults({ ...context, toolResults: [] }),
    ).resolves.toEqual({ toolResultUpdates: {} });
    await expect(
      registry.onModelResponse({ ...context, response: "provider" }),
    ).resolves.toBe("provider");
    await registry.complete(context);
    await registry.fail({ ...context, error: new Error("provider failed") });

    expect(set).not.toHaveBeenCalled();
  });

  test("runs registered plugins in order and stops at a refusal", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    registry.register({
      id: "first",
      async onToolCalls() {
        events.push("first");
      },
    });
    registry.register({
      id: "deny",
      async onToolCalls() {
        events.push("deny");
        return {
          decision: "refuse",
          refusal: {
            refusalMessage: "blocked",
            contentMessage: "blocked",
            reason: "test block",
            blockedToolName: "read",
            toolInput: {},
            allToolCallNames: ["read"],
          },
        };
      },
    });
    registry.register({
      id: "after-denial",
      async onToolCalls() {
        events.push("after-denial");
      },
    });

    await registry.onSessionInit(requestContext());
    await expect(
      registry.onToolCalls({ ...requestContext(), toolCalls: [] }),
    ).resolves.toEqual({
      decision: "refuse",
      refusal: {
        refusalMessage: "blocked",
        contentMessage: "blocked",
        reason: "test block",
        blockedToolName: "read",
        toolInput: {},
        allToolCallNames: ["read"],
      },
    });
    expect(events).toEqual(["first", "deny"]);
  });

  test("does not partially register a plugin batch when validation fails", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    registry.register({
      id: "existing",
      async onSessionInit() {
        events.push("existing");
      },
    });

    expect(() =>
      registry.registerAll([
        {
          id: "new",
          async onSessionInit() {
            events.push("new");
          },
        },
        { id: "existing" },
      ]),
    ).toThrow("LLM proxy plugin existing is already registered");

    await registry.onSessionInit(requestContext());
    expect(events).toEqual(["existing"]);
  });

  test("retries failed plugin loading and coalesces concurrent attempts", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    let attempts = 0;
    const initializer = new LlmProxyPluginInitializer(registry, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("plugin module unavailable");
      return [
        {
          id: "loaded-plugin",
          async onSessionInit() {
            events.push("initialized");
          },
        },
      ];
    });

    const first = initializer.initialize();
    const concurrentFirst = initializer.initialize();
    expect(attempts).toBe(1);
    await expect(first).rejects.toThrow("plugin module unavailable");
    await expect(concurrentFirst).rejects.toThrow("plugin module unavailable");
    expect(registry.hasPlugins()).toBe(false);

    await Promise.all([initializer.initialize(), initializer.initialize()]);
    expect(attempts).toBe(2);
    await registry.onSessionInit(requestContext());
    expect(events).toEqual(["initialized"]);
  });

  test("chains tool and response transformations in registration order", async () => {
    const registry = new LlmProxyPluginRegistry();
    const context = requestContext();
    let secondPluginArguments: unknown;
    registry.register({
      id: "first",
      async onToolCalls({ toolCalls }) {
        return {
          decision: "allow",
          toolCalls: toolCalls.map((toolCall) => ({
            ...toolCall,
            name: `first_${toolCall.name}`,
          })),
        };
      },
      async onModelResponse({ response }) {
        return { response: `${response}:first` };
      },
    });
    registry.register({
      id: "second",
      async onToolCalls({ toolCalls }) {
        secondPluginArguments = toolCalls[0]?.arguments;
        return {
          decision: "allow",
          toolCalls: toolCalls.map((toolCall) => ({
            ...toolCall,
            name: `second_${toolCall.name}`,
          })),
        };
      },
      async onModelResponse({ response }) {
        return { response: `${response}:second` };
      },
    });

    await registry.onSessionInit(context);
    await expect(
      registry.onToolCalls({
        ...context,
        toolCalls: [{ id: "call-1", name: "read", arguments: {} }],
      }),
    ).resolves.toEqual({
      decision: "allow",
      toolCalls: [{ id: "call-1", name: "second_first_read", arguments: {} }],
    });
    expect(secondPluginArguments).toEqual({});
    await expect(
      registry.onModelResponse({ ...context, response: "provider" }),
    ).resolves.toBe("provider:first:second");
    await registry.complete(context);
  });

  test("passes transformed tool results to later plugins", async () => {
    const registry = new LlmProxyPluginRegistry();
    const context = requestContext();
    registry.register({
      id: "redact",
      async onToolResults() {
        return { toolResultUpdates: { "call-1": "redacted" } };
      },
    });
    registry.register({
      id: "observe-redaction",
      async onToolResults({ toolResults }) {
        expect(toolResults[0]?.content).toBe("redacted");
        return { toolResultUpdates: { "call-2": "derived" } };
      },
    });

    await registry.onSessionInit(context);
    await expect(
      registry.onToolResults({
        ...context,
        toolResults: [
          { id: "call-1", name: "read", content: "raw", isError: false },
        ],
      }),
    ).resolves.toEqual({
      toolResultUpdates: { "call-1": "redacted", "call-2": "derived" },
    });
    await registry.complete(context);
  });

  test("fails closed and cleans initialized plugins in reverse order", async () => {
    const registry = new LlmProxyPluginRegistry();
    const events: string[] = [];
    const plugins: LlmProxyPlugin[] = [
      {
        id: "first",
        async onCleanup() {
          events.push("first-cleanup");
        },
      },
      {
        id: "broken",
        async onBeforeModel() {
          throw new Error("unavailable");
        },
        async onCleanup() {
          events.push("broken-cleanup");
        },
      },
    ];
    plugins.forEach((plugin) => {
      registry.register(plugin);
    });
    const context = requestContext();
    await registry.onSessionInit(context);

    await expect(
      registry.onBeforeModel({ ...context, request: {} }),
    ).rejects.toThrow("LLM proxy plugin broken failed during onBeforeModel");
    await registry.fail({ ...context, error: new Error("unavailable") });
    expect(events).toEqual(["broken-cleanup", "first-cleanup"]);
  });

  test("removes a partial session when initialization cleanup fails", async () => {
    const registry = new LlmProxyPluginRegistry();
    const context = requestContext();
    const events: string[] = [];
    registry.register({
      id: "cleanup-fails",
      async onCleanup() {
        throw new Error("cleanup unavailable");
      },
    });
    registry.register({
      id: "broken-init",
      async onSessionInit() {
        throw new Error("initialization unavailable");
      },
      async onCleanup() {
        events.push("broken-init-cleanup");
      },
    });

    await expect(registry.onSessionInit(context)).rejects.toThrow(
      "LLM proxy plugin cleanup-fails failed during onCleanup",
    );
    expect(events).toEqual(["broken-init-cleanup"]);
    await expect(registry.onSessionInit(context)).rejects.toThrow(
      "LLM proxy plugin cleanup-fails failed during onCleanup",
    );
  });

  test.each([
    "complete",
    "fail",
  ] as const)("removes a session after %s cleanup fails", async (phase) => {
    const registry = new LlmProxyPluginRegistry();
    const context = requestContext();
    registry.register({
      id: "cleanup-fails",
      async onCleanup() {
        throw new Error("cleanup unavailable");
      },
    });

    await registry.onSessionInit(context);
    if (phase === "complete") {
      await expect(registry.complete(context)).rejects.toThrow(
        "LLM proxy plugin cleanup-fails failed during onCleanup",
      );
    } else {
      await expect(
        registry.fail({ ...context, error: new Error("request unavailable") }),
      ).rejects.toThrow(
        "LLM proxy plugin cleanup-fails failed during onCleanup",
      );
    }
    await expect(registry.onSessionInit(context)).resolves.toBeUndefined();
  });
});
