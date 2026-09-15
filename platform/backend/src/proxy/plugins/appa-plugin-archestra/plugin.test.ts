import { describe, expect, test } from "@/test";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { createAppaLlmProxyPlugin } from "./index";

describe("AppaPluginArchestra", () => {
  test("registers default client adapters and resolves by protocol", () => {
    const plugin = createAppaLlmProxyPlugin();
    expect(plugin.getClientAdapters().length).toBeGreaterThanOrEqual(3);

    const anthropicAdapter = plugin.resolveClientAdapter({
      protocol: "anthropic",
      headers: { "user-agent": "Claude-Code/2.1.258" },
      requestBody: {},
    });
    expect(anthropicAdapter?.id).toBe("claude-code");

    const codexAdapter = plugin.resolveClientAdapter({
      protocol: "responses",
      headers: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-123" }),
      },
      requestBody: {},
    });
    expect(codexAdapter?.id).toBe("codex");

    const opencodeAdapter = plugin.resolveClientAdapter({
      protocol: "chat_completions",
      headers: { "x-opencode-session": "session-456" },
      requestBody: {},
    });
    expect(opencodeAdapter?.id).toBe("opencode");
  });

  describe("AppaClaudeCodeAdapter", () => {
    const adapter = new AppaClaudeCodeAdapter();

    test("extracts session identity and tool calls from Anthropic Messages", () => {
      const identity = adapter.resolveSessionIdentity({
        headers: {
          "x-claude-code-session-id": "claude-session-1",
          "x-appa-spawn-binding": "untrusted-binding",
        },
        requestBody: {},
      });
      expect(identity).toEqual({
        clientSessionId: "claude-session-1",
        threadId: "claude-session-1",
      });

      const toolCalls = adapter.extractToolCalls({
        content: [
          { type: "text", text: "executing tool" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls -la" },
          },
        ],
      });
      expect(toolCalls).toEqual([
        {
          id: "toolu_1",
          name: "Bash",
          arguments: { command: "ls -la" },
          raw: expect.any(Object),
          spawn: false,
        },
      ]);
    });

    test("rewrites tool calls into Anthropic response", () => {
      const original = {
        content: [
          {
            type: "tool_use",
            id: "toolu_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      };
      const rewritten = adapter.rewriteToolCalls(original, [
        {
          id: "toolu_1",
          name: "Bash",
          arguments: { command: "ls -la /safe" },
        },
      ]) as typeof original;
      expect(rewritten.content[0]).toMatchObject({
        name: "Bash",
        input: { command: "ls -la /safe" },
      });
    });

    test("extracts tool results from Anthropic request", () => {
      const results = adapter.extractToolResults({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "output data",
                is_error: false,
              },
            ],
          },
        ],
      });
      expect(results).toEqual([
        {
          id: "toolu_1",
          content: "output data",
          isError: false,
        },
      ]);
    });
  });

  describe("AppaCodexAdapter", () => {
    const adapter = new AppaCodexAdapter();

    test("extracts session identity and tool calls from OpenAI Responses", () => {
      const identity = adapter.resolveSessionIdentity({
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "codex-thread-1",
          }),
          "x-session-id": "synthetic-session",
          "x-appa-spawn-binding": "untrusted-binding",
        },
        requestBody: {},
      });
      expect(identity).toEqual({
        clientSessionId: "codex-thread-1",
        threadId: "codex-thread-1",
      });

      const toolCalls = adapter.extractToolCalls({
        output: [
          {
            type: "function_call",
            call_id: "call_codex_1",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "pwd" }),
          },
        ],
      });
      expect(toolCalls).toEqual([
        {
          id: "call_codex_1",
          name: "exec_command",
          arguments: { cmd: "pwd" },
          raw: expect.any(Object),
          spawn: false,
        },
      ]);
    });

    test("rewrites tool calls and extracts results for Responses", () => {
      const original = {
        output: [
          {
            type: "function_call",
            call_id: "call_codex_1",
            name: "exec_command",
            arguments: '{"cmd":"pwd"}',
          },
        ],
      };
      const rewritten = adapter.rewriteToolCalls(original, [
        {
          id: "call_codex_1",
          name: "exec_command",
          arguments: { cmd: "whoami" },
        },
      ]) as typeof original;
      expect(rewritten.output[0]?.arguments).toBe('{"cmd":"whoami"}');

      const results = adapter.extractToolResults({
        input: [
          {
            type: "function_call_output",
            call_id: "call_codex_1",
            output: "root",
          },
        ],
      });
      expect(results).toEqual([
        {
          id: "call_codex_1",
          content: "root",
        },
      ]);
    });
  });

  describe("AppaOpenCodeAdapter", () => {
    const adapter = new AppaOpenCodeAdapter();

    test("extracts session identity and tool calls from OpenAI Chat Completions", () => {
      const identity = adapter.resolveSessionIdentity({
        headers: {
          "x-opencode-session": "opencode-session-1",
          "x-parent-session-id": "opencode-parent-1",
          "x-session-affinity": "synthetic-session",
          "x-appa-spawn-binding": "untrusted-binding",
        },
        requestBody: {},
      });
      expect(identity).toEqual({
        clientSessionId: "opencode-session-1",
        parentSessionId: "opencode-parent-1",
        threadId: "opencode-session-1",
      });

      const toolCalls = adapter.extractToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "call_opencode_1",
                  type: "function",
                  function: {
                    name: "read_file",
                    arguments: '{"path":"foo.txt"}',
                  },
                },
              ],
            },
          },
        ],
      });
      expect(toolCalls).toEqual([
        {
          id: "call_opencode_1",
          name: "read_file",
          arguments: { path: "foo.txt" },
          raw: expect.any(Object),
          spawn: false,
        },
      ]);
    });

    test("canonicalizes local tool names into canonical APPA namespaces", () => {
      expect(adapter.canonicalizeLocalToolName("read_file")).toBe(
        "builtin:read_file",
      );
      expect(adapter.canonicalizeLocalToolName("builtin:already")).toBe(
        "builtin:already",
      );
      expect(adapter.canonicalizeLocalToolName("mcp:custom/tool")).toBe(
        "mcp:custom/tool",
      );
    });
  });

  describe("canonicalizeLocalToolName and spawn detection across adapters", () => {
    test("claude-code projects local tools and detects subagent spawns", () => {
      const claude = new AppaClaudeCodeAdapter();
      expect(claude.canonicalizeLocalToolName("Bash")).toBe(
        "host/claude-code/Bash",
      );
      expect(claude.canonicalizeLocalToolName("mcp__gw__read")).toBe(
        "mcp__gw__read",
      );

      const calls = claude.extractToolCalls({
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "Agent",
            input: { prompt: "sub-task" },
          },
          {
            type: "tool_use",
            id: "t2",
            name: "Bash",
            input: { command: "uptime" },
          },
        ],
      });
      expect(calls.map(({ name, spawn }) => ({ name, spawn }))).toEqual([
        { name: "Agent", spawn: true },
        { name: "Bash", spawn: false },
      ]);
    });

    test("adapters distinguish native spawns from gateway task lookalikes", () => {
      const codex = new AppaCodexAdapter();
      expect(codex.canonicalizeLocalToolName("functions.exec_command")).toBe(
        "builtin:exec_command",
      );
      expect(codex.canonicalizeLocalToolName("write_file")).toBe(
        "builtin:write_file",
      );
      expect(codex.canonicalizeLocalToolName("builtin:exec")).toBe(
        "builtin:exec",
      );

      const calls = codex.extractToolCalls({
        output: [
          {
            type: "function_call",
            call_id: "c1",
            namespace: "multi_agent_v1",
            name: "spawn_agent",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "c2",
            name: "mcp__server__task",
            arguments: "{}",
          },
        ],
      });
      expect(calls.map(({ name, spawn }) => ({ name, spawn }))).toEqual([
        { name: "multi_agent_v1.spawn_agent", spawn: true },
        { name: "mcp__server__task", spawn: false },
      ]);

      const opencode = new AppaOpenCodeAdapter();
      const opencodeCalls = opencode.extractToolCalls({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: "oc1",
                  function: { name: "task", arguments: "{}" },
                },
                {
                  id: "oc2",
                  function: { name: "mcp__server__task", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
      expect(opencodeCalls.map((call) => call.spawn)).toEqual([true, false]);
    });
  });

  test("classifies native wire evidence through the owning adapter", () => {
    const plugin = createAppaLlmProxyPlugin();
    expect(
      plugin.resolveClientAdapter({
        protocol: "anthropic",
        provider: "anthropic",
        headers: {},
        requestBody: {
          metadata: { user_id: '{"session_id":"claude-session"}' },
          system:
            "x-anthropic-billing-header: cc_version=2.1.258; cc_entrypoint=claude-code;",
        },
      })?.nativeClient,
    ).toBe("claude-code");
    expect(
      plugin.resolveClientAdapter({
        protocol: "responses",
        provider: "openai",
        headers: { originator: "codex_cli_rs" },
        requestBody: { client_metadata: { thread_id: "codex-thread" } },
      })?.nativeClient,
    ).toBe("codex-responses-v1");
    expect(
      plugin.resolveClientAdapter({
        protocol: "chat_completions",
        provider: "kimi",
        headers: { "user-agent": "opencode/1.18.29" },
        requestBody: {},
      })?.nativeClient,
    ).toBe("opencode-kimi");
  });

  test("keeps native child and lifecycle rules in their client adapters", () => {
    const carrier =
      "apc1.call_1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const claude = new AppaClaudeCodeAdapter();
    expect(
      claude.unsupportedNativeLifecycleReason({
        headers: {},
        requestBody: { messages: [{ role: "user", content: carrier }] },
      }),
    ).toContain("native child locator and signed proxy binding");
    expect(
      claude.extractCarrierChild({
        headers: { "x-claude-code-agent-id": "child-agent" },
        requestBody: { messages: [{ role: "user", content: carrier }] },
        sessionId: "parent-session",
      }),
    ).toEqual({
      parentClientSessionId: "parent-session",
      childClientSessionId: "claude:parent-session:agent:child-agent",
      requestThreadId: "parent-session",
    });

    const codex = new AppaCodexAdapter();
    expect(
      codex.unsupportedNativeLifecycleReason({
        headers: {},
        requestBody: {
          client_metadata: {
            "x-codex-turn-metadata": { forked_from_thread_id: "parent" },
          },
        },
      }),
    ).toContain("durable native lifecycle binding");
    expect(codex.nativeControlTarget?.("agents.wait_agent")).toBe(
      "host/codex/agents.wait_agent",
    );

    const opencode = new AppaOpenCodeAdapter();
    expect(
      opencode.unsupportedNativeLifecycleReason({
        headers: { "x-parent-session-id": "parent-session" },
        requestBody: {},
      }),
    ).toContain("signed native child binding");
    expect(
      opencode.extractCarrierChild({
        headers: { "x-parent-session-id": "parent-session" },
        requestBody: { messages: [{ role: "user", content: carrier }] },
        sessionId: "child-session",
      }),
    ).toEqual({
      parentClientSessionId: "parent-session",
      childClientSessionId: "child-session",
      requestThreadId: "child-session",
    });
  });

  test("does not identify native adapters from synthetic client headers", () => {
    const claude = new AppaClaudeCodeAdapter();
    expect(
      claude.matches({
        protocol: "anthropic",
        headers: { "x-client-app": "claude-code" },
        requestBody: {},
      }),
    ).toBe(false);
    expect(
      claude.resolveSessionIdentity({
        headers: {
          "x-session-id": "synthetic-session",
          "x-anthropic-session-id": "synthetic-anthropic-session",
          "x-appa-spawn-binding": "untrusted-binding",
        },
        requestBody: {},
      }),
    ).toEqual({});

    const codex = new AppaCodexAdapter();
    expect(
      codex.matches({
        protocol: "responses",
        headers: { "x-client-app": "codex" },
        requestBody: {},
      }),
    ).toBe(false);
    expect(
      codex.resolveSessionIdentity({
        headers: {
          "x-session-id": "synthetic-session",
          "x-appa-spawn-binding": "untrusted-binding",
        },
        requestBody: {},
      }),
    ).toEqual({});

    const opencode = new AppaOpenCodeAdapter();
    expect(
      opencode.matches({
        protocol: "chat_completions",
        headers: {
          "x-client-app": "opencode",
          "x-session-affinity": "synthetic-session",
        },
        requestBody: {},
      }),
    ).toBe(false);
    expect(
      opencode.resolveSessionIdentity({
        headers: {
          "x-session-id": "synthetic-session",
          "x-session-affinity": "synthetic-affinity",
          "x-appa-spawn-binding": "untrusted-binding",
        },
        requestBody: {},
      }),
    ).toEqual({});
  });
});
