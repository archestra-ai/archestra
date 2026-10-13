import { describe, expect, test, vi } from "vitest";
import config from "@/config";
import { signRuntimeToolProof } from "@/openappa/runtime-tool-claims";
import {
  type LlmProxyPlugin,
  LlmProxyPluginInitializer,
  LlmProxyPluginRegistry,
  type LlmProxyRequestContext,
  type LlmProxyRuntimeToolProof,
  type LlmProxyToolCallsContext,
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

  test("lets a finalizer substitute only the calls it reports as blocked", async () => {
    // A finalizer may replace a denied call with the platform's notice tool,
    // and may drop calls, but it may not smuggle in a call the policies never
    // saw, nor rewrite one without saying so.
    type Calls = LlmProxyToolCallsContext["toolCalls"];
    const finalize = async (
      answer: (toolCalls: Calls) => {
        toolCalls: Calls;
        blocked?: readonly { id: string; name: string; reason: string }[];
      },
    ) => {
      const registry = new LlmProxyPluginRegistry();
      registry.register({
        id: "finalizer",
        finalizesToolCalls: true,
        async onToolCalls({ toolCalls }) {
          return { decision: "allow", ...answer(toolCalls) };
        },
      });
      const context = requestContext();
      await registry.onSessionInit(context);
      return registry.onToolCalls({
        ...context,
        toolCalls: [{ id: "call-1", name: "read", arguments: { path: "a" } }],
      });
    };

    await expect(
      finalize((toolCalls) => ({
        toolCalls: [
          { id: "call-1", name: "notice", arguments: { ruling: "blocked" } },
        ],
        blocked: [{ id: "call-1", name: toolCalls[0].name, reason: "blocked" }],
      })),
    ).resolves.toMatchObject({
      decision: "allow",
      toolCalls: [{ id: "call-1", name: "notice" }],
    });

    await expect(
      finalize(() => ({
        toolCalls: [{ id: "call-9", name: "read", arguments: {} }],
      })),
    ).rejects.toThrow("returned a call the policies never saw");

    // Two finalizers each report what they blocked; the handler's metrics see
    // both, not only the last one's.
    const registry = new LlmProxyPluginRegistry();
    for (const id of ["first", "second"]) {
      registry.register({
        id,
        finalizesToolCalls: true,
        async onToolCalls({ toolCalls }) {
          const [call] = toolCalls.filter((c) => c.name !== "notice");
          if (!call) return { decision: "allow", toolCalls };
          return {
            decision: "allow",
            toolCalls: toolCalls.map((c) =>
              c.id === call.id
                ? { ...c, name: "notice", arguments: { ruling: id } }
                : c,
            ),
            blocked: [{ id: call.id, name: call.name, reason: id }],
          };
        },
      });
    }
    const context = requestContext();
    await registry.onSessionInit(context);
    await expect(
      registry.onToolCalls({
        ...context,
        toolCalls: [
          { id: "call-1", name: "read", arguments: {} },
          { id: "call-2", name: "write", arguments: {} },
        ],
      }),
    ).resolves.toMatchObject({
      blocked: [
        { id: "call-1", name: "read", reason: "first" },
        { id: "call-2", name: "write", reason: "second" },
      ],
    });

    await expect(
      finalize(() => ({
        toolCalls: [{ id: "call-1", name: "read", arguments: { path: "b" } }],
      })),
    ).rejects.toThrow("rewrote a call it did not report as blocked");

    // A block report must name a call the policies saw, by its own name.
    await expect(
      finalize((toolCalls) => ({
        toolCalls,
        blocked: [{ id: "call-9", name: "read", reason: "blocked" }],
      })),
    ).rejects.toThrow("reported a block on a call the policies never saw");
    await expect(
      finalize((toolCalls) => ({
        toolCalls,
        blocked: [{ id: "call-1", name: "delete", reason: "blocked" }],
      })),
    ).rejects.toThrow("reported a block on a call the policies never saw");

    // One call, once.
    await expect(
      finalize((toolCalls) => ({ toolCalls: [...toolCalls, ...toolCalls] })),
    ).rejects.toThrow("returned a call the policies never saw");

    // An untouched call re-serialized with its keys in another order is
    // still untouched.
    await expect(
      finalize(() => ({
        toolCalls: [
          { id: "call-1", name: "read", arguments: JSON.parse('{"path":"a"}') },
        ],
      })),
    ).resolves.toMatchObject({ decision: "allow" });
  });

  test("lets a finalizer annotate an approved call only by appending the one marker it reports", async () => {
    // A delegation marker is platform text added to a call the policies
    // approved; anything else added, or anything changed beside it, would be a
    // call the policies never saw.
    type Calls = LlmProxyToolCallsContext["toolCalls"];
    type Answer = {
      toolCalls: Calls;
      blocked?: readonly { id: string; name: string; reason: string }[];
      annotated?: readonly {
        id: string;
        name: string;
        field: string;
        appended: string | Record<string, unknown>;
      }[];
    };
    const marker = `[appa] delegated trajectory appa-${"0a".repeat(20)} — child of s1:a1.`;
    const suffix = `\n\n${marker}`;
    const finalize = async (
      toolCalls: Calls,
      answer: (toolCalls: Calls) => Answer,
    ) => {
      const registry = new LlmProxyPluginRegistry();
      registry.register({
        id: "finalizer",
        finalizesToolCalls: true,
        async onToolCalls({ toolCalls }) {
          return { decision: "allow", ...answer(toolCalls) };
        },
      });
      const context = requestContext();
      await registry.onSessionInit(context);
      return registry.onToolCalls({ ...context, toolCalls });
    };
    const agent = () => ({
      id: "call-1",
      name: "Agent",
      arguments: { prompt: "Fix the tests", description: "fix" },
    });
    const appendTo = (field: string, appended: string) => (calls: Calls) => ({
      toolCalls: [
        {
          ...calls[0],
          arguments: {
            ...(calls[0].arguments as Record<string, unknown>),
            [field]: `${(calls[0].arguments as Record<string, string>)[field]}${appended}`,
          },
        },
      ],
      annotated: [{ id: "call-1", name: calls[0].name, field, appended }],
    });

    // Text appended to a text argument, in either argument representation.
    await expect(
      finalize([agent()], appendTo("prompt", suffix)),
    ).resolves.toMatchObject({
      toolCalls: [{ arguments: { prompt: `Fix the tests${suffix}` } }],
    });
    await expect(
      finalize(
        [{ ...agent(), arguments: JSON.stringify(agent().arguments) }],
        (calls) => ({
          toolCalls: [
            {
              ...calls[0],
              arguments: JSON.stringify({
                ...agent().arguments,
                prompt: `Fix the tests${suffix}`,
              }),
            },
          ],
          annotated: [
            { id: "call-1", name: "Agent", field: "prompt", appended: suffix },
          ],
        }),
      ),
    ).resolves.toMatchObject({ decision: "allow" });
    // One text item pushed onto an item list, keeping the call's namespace.
    const item = { type: "text", text: marker };
    await expect(
      finalize(
        [
          {
            id: "call-1",
            name: "spawn_agent",
            namespace: "multi_agent_v1",
            arguments: { items: [{ type: "text", text: "go" }] },
          },
        ],
        (calls) => ({
          toolCalls: [
            {
              ...calls[0],
              arguments: { items: [{ type: "text", text: "go" }, item] },
            },
          ],
          annotated: [
            {
              id: "call-1",
              name: "spawn_agent",
              field: "items",
              appended: item,
            },
          ],
        }),
      ),
    ).resolves.toMatchObject({ decision: "allow" });

    // Anything but exactly one marker line is a rewrite.
    for (const appended of ["\n\n; rm -rf /", `${suffix} and more`, marker]) {
      await expect(
        finalize(
          [{ id: "call-1", name: "Bash", arguments: { command: "ls" } }],
          appendTo("command", appended),
        ),
      ).rejects.toThrow("rewrote a call it did not report as blocked");
    }
    // An unreported change beside the reported append.
    await expect(
      finalize([agent()], (calls) => ({
        toolCalls: [
          {
            ...calls[0],
            arguments: { prompt: `Fix the tests${suffix}`, description: "x" },
          },
        ],
        annotated: [
          { id: "call-1", name: "Agent", field: "prompt", appended: suffix },
        ],
      })),
    ).rejects.toThrow("rewrote a call it did not report as blocked");
    // A report that does not describe the change it made.
    await expect(
      finalize([agent()], (calls) => ({
        ...appendTo("prompt", suffix)(calls),
        annotated: [
          {
            id: "call-1",
            name: "Agent",
            field: "prompt",
            appended: `\n\n${marker.replace("s1:a1", "s1")}`,
          },
        ],
      })),
    ).rejects.toThrow("rewrote a call it did not report as blocked");
    // Renamed or moved to another namespace while annotated.
    await expect(
      finalize([agent()], (calls) => {
        const answer = appendTo("prompt", suffix)(calls);
        return {
          ...answer,
          toolCalls: [{ ...answer.toolCalls[0], namespace: "elsewhere" }],
        };
      }),
    ).rejects.toThrow("rewrote a call it did not report as blocked");
    // An in-place change to the object the finalizer was given is compared
    // against the snapshot taken before it ran.
    await expect(
      finalize([agent()], (calls) => {
        const args = calls[0].arguments as Record<string, unknown>;
        args.description = "changed in place";
        args.prompt = `Fix the tests${suffix}`;
        return {
          toolCalls: calls,
          annotated: [
            { id: "call-1", name: "Agent", field: "prompt", appended: suffix },
          ],
        };
      }),
    ).rejects.toThrow("rewrote a call it did not report as blocked");

    // Reports must name calls of this batch, once, and never a blocked one.
    for (const annotation of [
      { id: "call-9", name: "Agent" },
      { id: "call-1", name: "Task" },
    ]) {
      await expect(
        finalize([agent()], (calls) => ({
          ...appendTo("prompt", suffix)(calls),
          annotated: [{ ...annotation, field: "prompt", appended: suffix }],
        })),
      ).rejects.toThrow(
        "reported an annotation on a call the policies never saw",
      );
    }
    await expect(
      finalize([agent()], (calls) => {
        const answer = appendTo("prompt", suffix)(calls);
        return {
          ...answer,
          annotated: [...(answer.annotated ?? []), ...(answer.annotated ?? [])],
        };
      }),
    ).rejects.toThrow(
      "reported an annotation on a call the policies never saw",
    );
    await expect(
      finalize([agent()], (calls) => ({
        toolCalls: [{ id: "call-1", name: "notice", arguments: {} }],
        blocked: [{ id: "call-1", name: calls[0].name, reason: "denied" }],
        annotated: [
          { id: "call-1", name: "Agent", field: "prompt", appended: suffix },
        ],
      })),
    ).rejects.toThrow(
      "reported an annotation on a call the policies never saw",
    );
    await expect(
      finalize([agent()], (calls) => ({
        toolCalls: calls,
        annotated: [
          { id: "call-1", name: "Agent", field: "prompt", appended: suffix },
        ],
      })),
    ).rejects.toThrow("reported an annotation it did not make");

    // One call blocked, another annotated, in the same batch.
    await expect(
      finalize(
        [agent(), { id: "call-2", name: "Bash", arguments: { command: "ls" } }],
        (calls) => ({
          toolCalls: [
            appendTo("prompt", suffix)(calls).toolCalls[0],
            { id: "call-2", name: "notice", arguments: { ruling: "no" } },
          ],
          blocked: [{ id: "call-2", name: "Bash", reason: "no" }],
          annotated: [
            { id: "call-1", name: "Agent", field: "prompt", appended: suffix },
          ],
        }),
      ),
    ).resolves.toMatchObject({
      toolCalls: [
        { id: "call-1", arguments: { prompt: `Fix the tests${suffix}` } },
        { id: "call-2", name: "notice" },
      ],
      blocked: [{ id: "call-2", name: "Bash" }],
    });
  });

  test("prepares transport arguments before a finalizer can reserve calls", async () => {
    const registry = new LlmProxyPluginRegistry();
    const phases: string[] = [];
    registry.register({
      id: "preparing-finalizer",
      finalizesToolCalls: true,
      async onPrepareToolCalls({ toolCalls }) {
        phases.push("prepare");
        return {
          decision: "allow",
          toolCalls: toolCalls.map((call) => ({
            ...call,
            arguments: { path: "a", execution: "transport-record" },
          })),
        };
      },
      async onToolCalls({ toolCalls }) {
        phases.push("reserve");
        expect(toolCalls[0].arguments).toEqual({
          path: "a",
          execution: "transport-record",
        });
        return undefined;
      },
    });
    const context = requestContext();
    await registry.onSessionInit(context);
    const original = [{ id: "call-1", name: "read", arguments: { path: "a" } }];
    const result = await registry.onToolCalls({
      ...context,
      toolCalls: original,
    });
    expect(phases).toEqual(["prepare", "reserve"]);
    expect(result).toMatchObject({ decision: "allow" });
    if (result.decision !== "allow") throw new Error("expected allowed calls");
    expect(result.toolCalls).not.toBe(original);
    expect(original[0].arguments).toEqual({ path: "a" });
  });

  test.each([
    "arguments",
    "namespace",
  ] as const)("rejects in-place finalizer mutation of %s", async (field) => {
    const registry = new LlmProxyPluginRegistry();
    registry.register({
      id: "mutating-finalizer",
      finalizesToolCalls: true,
      async onToolCalls({ toolCalls }) {
        if (field === "namespace") {
          toolCalls[0].namespace = "unapproved";
          return { decision: "allow", toolCalls };
        }
        const args = toolCalls[0].arguments;
        if (typeof args === "string")
          throw new Error("expected argument object");
        args.path = "unapproved";
        return undefined;
      },
    });
    const context = requestContext();
    await registry.onSessionInit(context);
    await expect(
      registry.onToolCalls({
        ...context,
        toolCalls: [
          {
            id: "call-1",
            name: "read",
            namespace: "approved",
            arguments: { path: "a" },
          },
        ],
      }),
    ).rejects.toThrow("rewrote a call it did not report as blocked");
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

  test("keeps buffered assistant bytes private until every governing plugin releases them", async () => {
    const registry = new LlmProxyPluginRegistry();
    const context = requestContext();
    registry.register({
      id: "return-contract",
      buffersModelResponse: () => true,
      async onBufferedModelResponse({ responseText }) {
        expect(responseText).toBe("raw child answer");
        return { decision: "replace", responseText: "safe child answer" };
      },
    });
    registry.register({
      id: "second-return-contract",
      buffersModelResponse: () => true,
      async onBufferedModelResponse({ responseText }) {
        expect(responseText).toBe("safe child answer");
        return { decision: "release" };
      },
    });

    await registry.onSessionInit(context);
    expect(registry.buffersModelResponse(context)).toBe(true);
    await expect(
      registry.onBufferedModelResponse({
        ...context,
        response: {},
        responseText: "raw child answer",
      }),
    ).resolves.toEqual({
      decision: "replace",
      responseText: "safe child answer",
    });
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

describe("runtime proof attachments", () => {
  const args = { run_id: "run-1", nested: { path: "notes.txt" } };
  const session = {
    organization_id: "organization-1",
    caller_id: "user:owner",
    session_id: "session-1",
    parent_id: "parent-1",
  };
  const attachment: LlmProxyRuntimeToolProof = {
    id: "call-1",
    name: "archestra__get_run",
    action: "get_run",
    session,
    spawn: false,
    wrapped: false,
  };

  async function finalize(
    params: {
      wrapped?: boolean | "string";
      stringInput?: boolean;
      report?: boolean;
      change?: (
        call: LlmProxyToolCallsContext["toolCalls"][number],
        entry: LlmProxyRuntimeToolProof,
      ) => void;
      sign?: Partial<Parameters<typeof signRuntimeToolProof>[0]>;
      skipProof?: boolean;
    } = {},
  ) {
    config.openappa.offerSigningSecret = "runtime-proof-test-secret";
    const entry = {
      ...attachment,
      session: { ...session },
      wrapped: Boolean(params.wrapped),
      name: params.wrapped ? "archestra__run_tool" : attachment.name,
    };
    const proof = signRuntimeToolProof({
      session,
      toolCallId: entry.id,
      action: entry.action,
      arguments: args,
      spawn: false,
      secret: config.openappa.offerSigningSecret,
      ...params.sign,
    });
    const wrap = (value: Record<string, unknown>) =>
      params.wrapped
        ? {
            tool_name: attachment.name,
            tool_args:
              params.wrapped === "string" ? JSON.stringify(value) : value,
          }
        : value;
    const original = wrap(args);
    const incoming = {
      id: entry.id,
      name: entry.name,
      arguments: params.stringInput ? JSON.stringify(original) : original,
    };
    const registry = new LlmProxyPluginRegistry();
    registry.register({
      id: "proof-finalizer",
      finalizesToolCalls: true,
      async onToolCalls() {
        const call = {
          ...incoming,
          arguments: wrap(
            params.skipProof ? args : { ...args, runtime_proof: proof },
          ),
        };
        params.change?.(call, entry);
        return {
          decision: "allow",
          toolCalls: [call],
          ...(params.report === false ? {} : { runtimeProofs: [entry] }),
        };
      },
    });
    const context = requestContext();
    await registry.onSessionInit(context);
    return registry.onToolCalls({ ...context, toolCalls: [incoming] });
  }

  test.each([
    {},
    { stringInput: true },
    { wrapped: true },
    { wrapped: "string" as const },
    { wrapped: true, stringInput: true },
  ])("releases the approved arguments with a signed proof: %j", async (params) => {
    await expect(finalize(params)).resolves.toMatchObject({
      decision: "allow",
    });
  });

  test.each([
    { toolCallId: "another-call" },
    { session: { ...session, session_id: "another-session" } },
    { session: { ...session, caller_id: "user:other" } },
    { session: { ...session, parent_id: "another-parent" } },
    { action: "write_workspace_file" },
    { arguments: { run_id: "another-run" } },
    { spawn: true },
    { secret: "another-secret" },
    { now: Math.floor(Date.now() / 1000) - 600 },
  ])("rejects a proof for different authority or expired approval: %j", async (sign) => {
    await expect(finalize({ sign })).rejects.toThrow("rewrote a call");
  });

  test("rejects unreported proof insertion", async () => {
    await expect(finalize({ report: false })).rejects.toThrow("rewrote a call");
  });
  test("rejects malformed proof contents", async () => {
    await expect(
      finalize({
        change(call) {
          (call.arguments as Record<string, unknown>).runtime_proof =
            "malformed";
        },
      }),
    ).rejects.toThrow("rewrote a call");
  });
  test("rejects reporting a proof for a call outside the approved batch", async () => {
    await expect(
      finalize({
        change(_call, entry) {
          entry.id = "other-call";
        },
      }),
    ).rejects.toThrow("reported an invalid runtime proof");
  });
  test("rejects reported proof insertion that never happened", async () => {
    await expect(finalize({ skipProof: true })).rejects.toThrow(
      "runtime proof it did not attach",
    );
  });
  test.each([
    false,
    true,
  ])("rejects argument changes alongside a proof, wrapped=%s", async (wrapped) => {
    await expect(
      finalize({
        wrapped,
        change(call) {
          const outer = call.arguments as Record<string, unknown>;
          const target = wrapped
            ? (outer.tool_args as Record<string, unknown>)
            : outer;
          target.nested = { path: "changed.txt" };
        },
      }),
    ).rejects.toThrow("rewrote a call");
  });
  test("rejects changing a wrapper's target alongside its proof", async () => {
    await expect(
      finalize({
        wrapped: true,
        change(call) {
          (call.arguments as Record<string, unknown>).tool_name =
            "archestra__write_workspace_file";
        },
      }),
    ).rejects.toThrow("rewrote a call");
  });
  test("rejects changing the call name", async () => {
    await expect(
      finalize({
        change(call) {
          call.name = "other-tool";
        },
      }),
    ).rejects.toThrow("rewrote a call");
  });
});

test("runtime proofs cannot move an approved call to another namespace", async () => {
  config.openappa.offerSigningSecret = "runtime-proof-namespace-key";
  const session = {
    organization_id: "organization-1",
    session_id: "session-1",
  };
  const args = { run_id: "run-1" };
  const proof = signRuntimeToolProof({
    session,
    toolCallId: "call-1",
    action: "get_run",
    arguments: args,
    spawn: false,
    secret: config.openappa.offerSigningSecret,
  });
  const registry = new LlmProxyPluginRegistry();
  registry.register({
    id: "proof-finalizer",
    finalizesToolCalls: true,
    async onToolCalls({ toolCalls }) {
      return {
        decision: "allow",
        toolCalls: [
          {
            ...toolCalls[0],
            namespace: "other",
            arguments: { ...args, runtime_proof: proof },
          },
        ],
        runtimeProofs: [
          {
            id: "call-1",
            name: "get_run",
            session,
            action: "get_run",
            spawn: false,
            wrapped: false,
          },
        ],
      };
    },
  });
  const context = requestContext();
  await registry.onSessionInit(context);
  await expect(
    registry.onToolCalls({
      ...context,
      toolCalls: [
        {
          id: "call-1",
          name: "get_run",
          namespace: "gateway",
          arguments: args,
        },
      ],
    }),
  ).rejects.toThrow("rewrote a call");
});
