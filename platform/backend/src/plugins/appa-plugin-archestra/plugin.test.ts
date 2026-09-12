import { describe, expect, test } from "@/test";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { getAppaPluginArchestra } from "./index";

describe("AppaPluginArchestra", () => {
  test("registers default client adapters and resolves by protocol", () => {
    const plugin = getAppaPluginArchestra();
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
      headers: { "x-session-affinity": "session-456" },
      requestBody: {},
    });
    expect(opencodeAdapter?.id).toBe("opencode");
  });

  describe("AppaClaudeCodeAdapter", () => {
    const adapter = new AppaClaudeCodeAdapter();

    test("extracts session identity and tool calls from Anthropic Messages", () => {
      const identity = adapter.extractSessionIdentity({
        headers: { "x-session-id": "claude-session-1" },
        requestBody: {},
      });
      expect(identity.clientSessionId).toBe("claude-session-1");

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
      const identity = adapter.extractSessionIdentity({
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: "codex-thread-1",
          }),
        },
        requestBody: {},
      });
      expect(identity.clientSessionId).toBe("codex-thread-1");

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
      const identity = adapter.extractSessionIdentity({
        headers: { "x-session-affinity": "opencode-session-1" },
        requestBody: {},
      });
      expect(identity.clientSessionId).toBe("opencode-session-1");

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
      expect(calls[0].spawn).toBe(true);
      expect(calls[1].spawn).toBe(false);
    });

    test("codex projects function names and detects subagent spawns", () => {
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
            name: "spawn_agent",
            arguments: "{}",
          },
          {
            type: "function_call",
            call_id: "c2",
            name: "exec_command",
            arguments: "{}",
          },
        ],
      });
      expect(calls[0].spawn).toBe(true);
      expect(calls[1].spawn).toBe(false);
    });
  });
});
