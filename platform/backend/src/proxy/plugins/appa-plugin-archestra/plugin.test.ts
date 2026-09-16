import * as appaService from "@/openappa/service";
import type { LlmProxyRequestContext } from "@/proxy/plugins/registry";
import { describe, expect, test, vi } from "@/test";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { AppaPluginArchestra } from "./plugin";
import { APPA_PLUGIN_TRUSTED_CONTEXT } from "./types";

describe("APPA client adapters", () => {
  test("maps each integrated client to its real local tool namespace", () => {
    const chat = new AppaChatAdapter();
    const claudeCode = new AppaClaudeCodeAdapter();
    const codex = new AppaCodexAdapter();
    const openCode = new AppaOpenCodeAdapter();

    expect(
      chat.matches({
        headers: {},
        requestBody: {},
        trustedContext: {
          session: {
            organization_id: "org",
            caller_id: "user:user",
            session_id: "conversation",
          },
          profileId: "profile",
          canonicalizeToolName: (name) => name,
          chatSource: "chat:tool_call_repair",
        },
      }),
    ).toBe(true);
    expect(chat.classifyToolName("archestra__run_command")).toBe("gateway");
    expect(chat.normalizeLocalToolName("read_file")).toBe("read_file");

    expect(
      claudeCode.matches({
        headers: { "User-Agent": "Claude-Code/1" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(
      codex.matches({
        headers: { originator: "codex" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(
      openCode.matches({
        headers: { "x-opencode-session": "s" },
        requestBody: {},
      }),
    ).toBe(true);
    expect(claudeCode.normalizeLocalToolName("host/claude-code/Bash")).toBe(
      "host/claude-code/Bash",
    );
    expect(codex.normalizeLocalToolName("functions.exec_command")).toBe(
      "builtin:exec_command",
    );
    expect(codex.normalizeLocalToolName("functions.builtin:read_file")).toBe(
      "builtin:read_file",
    );
    expect(openCode.normalizeLocalToolName("read_file")).toBe(
      "builtin:read_file",
    );
    expect(openCode.classifyToolName("mcp:gateway:read")).toBe("gateway");
    expect(claudeCode.classifyToolName("mcp__gateway__read")).toBe("gateway");
    expect(claudeCode.classifyToolName("Bash")).toBe("local");
  });
});

describe("AppaPluginArchestra", () => {
  test.each([
    "openai:responses",
    "openai:chatCompletions",
  ])("serializes model tool requests only for bound policy sessions (%s)", async (interactionType) => {
    const plugin = new AppaPluginArchestra([]);
    const context = {
      ...requestContext({
        sessionId: "tools",
        canonicalizeToolName: (name) => name,
      }),
      interactionType,
    };
    for (const parallel of [undefined, true, false]) {
      const request = {
        model: "model",
        tools: [{ type: "function", name: "read_file" }],
        parallel_tool_calls: parallel,
      };
      await plugin.onBeforeModel({ ...context, request });
      expect(request.parallel_tool_calls).toBe(parallel);
      await plugin.onSessionInit(context);
      await plugin.onBeforeModel({ ...context, request });
      expect(request.parallel_tool_calls).toBe(false);
      expect(request.tools).toEqual([{ type: "function", name: "read_file" }]);
      await plugin.onCleanup(context);
    }
    await plugin.onSessionInit(context);
    const unsupported = { parallel_tool_calls: true };
    await plugin.onBeforeModel({
      ...context,
      interactionType: "gemini:generateContent",
      request: unsupported,
    });
    expect(unsupported.parallel_tool_calls).toBe(true);
  });

  test("keeps bindings private to each request and deletes them at cleanup", async () => {
    const canonicalizedNames: string[] = [];
    const checkToolCalls = vi
      .spyOn(appaService, "checkToolCalls")
      .mockImplementation(async (_session, _calls, canonicalize) => {
        canonicalizedNames.push(canonicalize("read_file"));
        return null;
      });
    const plugin = new AppaPluginArchestra([
      {
        id: "test-adapter",
        matches: () => true,
        classifyToolName: () => "local",
        normalizeLocalToolName: (name) => `local:${name}`,
      },
    ]);
    const first = requestContext({
      sessionId: "first-session",
      canonicalizeToolName: (name) => `first:${name}`,
    });
    const second = requestContext({
      sessionId: "second-session",
      canonicalizeToolName: (name) => `second:${name}`,
    });

    try {
      await plugin.onSessionInit(first);
      await plugin.onSessionInit(second);
      // These were private map keys before the binding moved into the plugin.
      // A later plugin can still mutate shared resources, but cannot replace
      // APPA's selected adapter or session binding.
      first.resources.set("archestra.appa.binding", {
        canonicalizeToolName: () => "overwritten",
      });
      first.resources.set("archestra.appa.adapter", {
        classifyToolName: () => "gateway",
      });
      first.resources.set(APPA_PLUGIN_TRUSTED_CONTEXT, {
        session: {
          organization_id: "other-organization",
          caller_id: "user:other",
          session_id: "other-session",
        },
        profileId: "other-profile",
        canonicalizeToolName: () => "overwritten",
      });

      await plugin.onToolCalls({
        ...first,
        toolCalls: [{ id: "first-call", name: "read_file", arguments: {} }],
      });
      await plugin.onToolCalls({
        ...second,
        toolCalls: [{ id: "second-call", name: "read_file", arguments: {} }],
      });

      expect(canonicalizedNames).toEqual([
        "first:local:read_file",
        "second:local:read_file",
      ]);
      expect(
        checkToolCalls.mock.calls.map(([session]) => session.session_id),
      ).toEqual(["first-session", "second-session"]);

      await plugin.onCleanup(first);
      await expect(
        plugin.onToolCalls({
          ...first,
          toolCalls: [{ id: "cleaned-call", name: "read_file", arguments: {} }],
        }),
      ).resolves.toBeUndefined();
      expect(checkToolCalls).toHaveBeenCalledTimes(2);
    } finally {
      checkToolCalls.mockRestore();
    }
  });
});

function requestContext(params: {
  sessionId: string;
  canonicalizeToolName: (name: string) => string;
}): LlmProxyRequestContext {
  return {
    requestId: params.sessionId,
    organizationId: "organization",
    profileId: "profile",
    provider: "anthropic",
    interactionType: "anthropic:messages",
    model: "model",
    streaming: false,
    headers: {},
    requestBody: {},
    resources: new Map([
      [
        APPA_PLUGIN_TRUSTED_CONTEXT,
        {
          session: {
            organization_id: "organization",
            caller_id: "user:user",
            session_id: params.sessionId,
          },
          profileId: "profile",
          canonicalizeToolName: params.canonicalizeToolName,
        },
      ],
    ]),
  };
}
