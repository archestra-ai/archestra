import { describe, expect, test } from "vitest";
import config from "@/config";
import { mintChildTrajectoryReceipt } from "@/openappa/child-trajectory-receipt";
import { mintDelegationMarker } from "@/openappa/delegation";
import { prepareAppaRequest } from "@/openappa/request";
import { ApiError } from "@/types";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";
import { referencesChildTranscriptPath } from "./adapters/trajectory";
import type { AppaMatchContext } from "./types";

describe("APPA child trajectory adapters", () => {
  const claudeCode = new AppaClaudeCodeAdapter();
  const codex = new AppaCodexAdapter();
  const openCode = new AppaOpenCodeAdapter();
  const chat = new AppaChatAdapter();

  test("keeps Claude Code Skill in-session before a real child spawn", () => {
    expect(claudeCode.isSpawnTool("Skill")).toBe(false);
    expect(claudeCode.isSpawnTool("host/claude-code/Skill")).toBe(false);
    expect(claudeCode.isSpawnTool("Agent")).toBe(true);
    expect(claudeCode.isSpawnTool("Task")).toBe(true);
    expect(claudeCode.isSpawnTool("host/claude-code/Agent")).toBe(true);
    expect(claudeCode.isSpawnTool("Bash")).toBe(false);
  });

  test("classifies Codex spawn_agent as spawn, not wait or resume", () => {
    expect(codex.isSpawnTool("spawn_agent")).toBe(true);
    expect(codex.isSpawnTool("functions.spawn_agent")).toBe(true);
    expect(codex.isSpawnTool("builtin:spawn_agent")).toBe(true);
    expect(codex.isSpawnTool("spawn_agent", "functions")).toBe(true);
    expect(codex.isSpawnTool("spawn_agent", "multi_agent_v1")).toBe(true);
    expect(codex.isSpawnTool("spawn_agent", "mcp__foreign")).toBe(false);
    expect(codex.isSpawnTool("wait_agent")).toBe(false);
    expect(codex.isSpawnTool("resume_agent")).toBe(false);
  });

  test("Codex distinguishes a started child from a rejected spawn launch", () => {
    expect(
      codex.classifySpawnResult?.({
        id: "started",
        name: "spawn_agent",
        content: '{"agent_id":"child-thread","nickname":"worker"}',
        isError: false,
      }),
    ).toBe("pending");
    expect(
      codex.classifySpawnResult?.({
        id: "rejected",
        name: "spawn_agent",
        content: "The selected model does not support this reasoning effort",
        isError: false,
      }),
    ).toBe("failed");
    expect(
      codex.normalizeChildLaunchResult?.({
        id: "rejected",
        name: "spawn_agent",
        content: "The selected model does not support this reasoning effort",
        isError: false,
      }),
    ).toBeUndefined();
    expect(
      codex.classifySpawnResult?.({
        id: "foreign-spawn",
        name: "spawn_agent",
        namespace: "mcp__foreign",
        content: '{"agent_id":"foreign"}',
        isError: false,
      }),
    ).toBeUndefined();
    expect(
      codex.classifySpawnResult?.({
        id: "started-v2",
        name: "spawn_agent",
        content: '{"task_name":"research","nickname":"worker"}',
        isError: false,
      }),
    ).toBe("pending");
    expect(
      codex.classifySpawnResult?.({
        id: "wait",
        name: "wait_agent",
        content: '{"status":{"child-thread":{"completed":"done"}}}',
        isError: false,
      }),
    ).toBeUndefined();
  });

  test("distinguishes completed child returns from launch acknowledgments", () => {
    const safeLaunch = "Async agent launched successfully.\nagentId: a1";
    const claudeLaunch = {
      id: "claude-spawn",
      name: "Agent",
      content:
        "Async agent launched successfully.\nagentId: a1\noutput_file: /tmp/a1.output",
      isError: false,
    };
    expect(claudeCode.normalizeChildLaunchResult(claudeLaunch)).toBe(
      safeLaunch,
    );
    expect(claudeCode.isChildHandbackTool?.("SubagentHandback")).toBe(true);
    expect(
      claudeCode.childHandbackValue?.({
        message: "REPORT-RAW-KOALA-0831",
      }),
    ).toBe("REPORT-RAW-KOALA-0831");
    expect(
      claudeCode.rewriteChildHandback?.(
        { message: "REPORT-RAW-KOALA-0831" },
        "SUMMARY(24 characters): safe",
      ),
    ).toEqual({ message: "SUMMARY(24 characters): safe" });
    expect(
      claudeCode.rewriteChildHandback?.(
        {
          message: "REPORT-RAW-KOALA-0831",
          output: "RAW-OUTPUT-SECRET",
          arbitrary: "ARBITRARY-SECRET",
        },
        "SUMMARY(24 characters): safe",
      ),
    ).toEqual({ message: "SUMMARY(24 characters): safe" });
    expect(claudeCode.isChildCompletionResult?.(claudeLaunch)).toBe(false);
    const realBackgroundLaunch = {
      ...claudeLaunch,
      content: `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)
agentId: aba0d3860dedb562b (internal ID - do not mention to user. Use SendMessage with to: 'aba0d3860dedb562b', summary: '<5-10 word recap>' to continue this agent.)
The agent is working in the background. You will be notified automatically when it completes. You know nothing about its results until that notification arrives — do not report, assume, or predict them; continue other work or respond to the user in the meantime.
Do not duplicate this agent's work — avoid working with the same files or topics it is using.
output_file: /tmp/claude/tasks/aba0d3860dedb562b.output
Do NOT Read or tail this file via the shell tool — it is the full subagent JSONL transcript and reading it will overflow your context. If the user asks for progress, say the agent is still running; you'll get a completion notification.`,
    };
    expect(claudeCode.normalizeChildLaunchResult(realBackgroundLaunch)).toBe(
      "Async agent launched successfully.\nagentId: aba0d3860dedb562b",
    );
    expect(claudeCode.isChildCompletionResult?.(realBackgroundLaunch)).toBe(
      false,
    );
    const contentBlocks = {
      ...realBackgroundLaunch,
      content: [{ type: "text", text: realBackgroundLaunch.content }],
    };
    expect(claudeCode.normalizeChildLaunchResult(contentBlocks)).toBe(
      "Async agent launched successfully.\nagentId: aba0d3860dedb562b",
    );
    expect(claudeCode.isChildCompletionResult?.(contentBlocks)).toBe(false);
    expect(
      claudeCode.normalizeChildLaunchResult({
        ...contentBlocks,
        content: [...contentBlocks.content, { type: "text", text: "extra" }],
      }),
    ).toBeUndefined();
    const prefixedRawOutput = {
      ...claudeLaunch,
      content:
        "Async agent launched successfully. RAW-SECRET\nagentId: a1\nREPORT-RAW-KOALA-0831",
    };
    expect(claudeCode.normalizeChildLaunchResult(prefixedRawOutput)).toBe(
      safeLaunch,
    );
    expect(
      claudeCode.normalizeChildLaunchResult(prefixedRawOutput),
    ).not.toContain("RAW");
    expect(
      claudeCode.isChildCompletionResult?.({
        ...claudeLaunch,
        content: "SUMMARY(...)",
      }),
    ).toBe(true);
    expect(
      claudeCode.isChildCompletionResult?.({
        ...claudeLaunch,
        content:
          "agent notes\noutput_file: /tmp/a1.output\nREPORT-RAW-KOALA-0831",
      }),
    ).toBe(true);
    const jsonLaunch = {
      ...claudeLaunch,
      content:
        '{"status":"async_launched","agent_id":"a1","output_file":"REPORT-RAW-KOALA-0831"}',
    };
    expect(claudeCode.normalizeChildLaunchResult(jsonLaunch)).toBe(safeLaunch);
    expect(claudeCode.isChildCompletionResult?.(jsonLaunch)).toBe(false);
    expect(
      claudeCode.normalizeChildLaunchResult({
        ...claudeLaunch,
        name: "Task",
        content: { status: "async_launched", task_id: "task-7" },
      }),
    ).toBe("Async agent launched successfully.\ntaskId: task-7");
    for (const content of [
      "Async agent launched successfully.\nREPORT-RAW-KOALA-0831",
      "Async agent launched successfully.\nagentId: bad id",
      `Async agent launched successfully.\nagentId: ${"a".repeat(129)}`,
      '{"status":"async_launched","agent_id":"bad id"}',
      "The agent is working in the background.\nagentId: a1",
    ]) {
      const malformed = { ...claudeLaunch, content };
      expect(claudeCode.normalizeChildLaunchResult(malformed)).toBeUndefined();
      expect(claudeCode.isChildCompletionResult?.(malformed)).toBe(true);
    }
    expect(
      codex.isChildCompletionResult?.({
        id: "wait",
        name: "wait_agent",
        content: '{"status":{"t1":{"completed":"SUMMARY(...)"}}}',
        isError: false,
      }),
    ).toBe(true);
    expect(
      codex.isChildCompletionResult?.({
        id: "wait",
        name: "wait_agent",
        content: '{"status":{"t1":"running"}}',
        isError: false,
      }),
    ).toBe(false);
    const foreignPayload = {
      status: { job: { completed: "FOREIGN" } },
      total: 1,
    };
    const beforeForeign = JSON.stringify(foreignPayload);
    expect(
      codex.isChildCompletionResult?.({
        id: "foreign-wait",
        name: "wait_agent",
        namespace: "mcp__foreign",
        content: foreignPayload,
        isError: false,
      }),
    ).toBe(false);
    expect(JSON.stringify(foreignPayload)).toBe(beforeForeign);
    for (const namespace of [undefined, "functions", "multi_agent_v1"]) {
      expect(
        codex.isChildCompletionResult?.({
          id: `native-${namespace ?? "flat"}`,
          name: "wait_agent",
          ...(namespace ? { namespace } : {}),
          content: '{"status":{"t1":{"completed":"SUMMARY(...)"}}}',
          isError: false,
        }),
      ).toBe(true);
    }
    const openCodeResult = {
      id: "opencode-spawn",
      name: "task",
      content: "task: oc-child\nSUMMARY(...)",
      isError: false,
    };
    expect(openCode.isChildCompletionResult?.(openCodeResult)).toBe(true);
  });

  test("keeps OpenCode skill in-session before a real child spawn", () => {
    expect(openCode.isSpawnTool("skill")).toBe(false);
    expect(openCode.isSpawnTool("builtin:skill")).toBe(false);
    expect(openCode.isSpawnTool("task")).toBe(true);
    expect(openCode.isSpawnTool("builtin:task")).toBe(true);
    expect(openCode.isSpawnTool("host/archestra/task")).toBe(true);
    expect(openCode.isSpawnTool("bash")).toBe(false);
  });

  test("keeps foreign-namespaced OpenCode task lookalikes out of native spawn and completion", () => {
    // OpenCode declares no wire namespaces: a namespaced `task` is a foreign
    // tool that shares the native name (OpenCode also speaks the Responses
    // wire, where MCP servers declare `mcp__<server>` namespaces).
    expect(openCode.isSpawnTool("task", "mcp__foreign")).toBe(false);
    expect(openCode.isSpawnTool("task", "multi_agent_v1")).toBe(false);
    // Other clients' native spellings are not OpenCode's.
    expect(openCode.isSpawnTool("functions.task")).toBe(false);
    expect(openCode.isSpawnTool("host/claude-code/task")).toBe(false);
    expect(openCode.isSpawnTool("host/task")).toBe(false);
    // OpenCode's own MCP/gateway spellings never reduce to the native name.
    expect(openCode.isSpawnTool("mcp:foreign:task")).toBe(false);
    expect(openCode.isSpawnTool("foreign__task")).toBe(false);

    const foreignResult = {
      id: "foreign-task",
      name: "task",
      namespace: "mcp__foreign",
      content: "task: oc-child\nSUMMARY(...)",
      isError: false,
    };
    expect(openCode.isChildCompletionResult?.(foreignResult)).toBe(false);
    expect(
      openCode.isChildCompletionResult?.({
        ...foreignResult,
        namespace: "multi_agent_v1",
      }),
    ).toBe(false);
    expect(
      openCode.isChildCompletionResult?.({
        ...foreignResult,
        namespace: undefined,
        name: "host/claude-code/task",
      }),
    ).toBe(false);

    // The native spellings still classify, as call and as result.
    const { namespace: _foreign, ...nativeResult } = foreignResult;
    expect(openCode.isChildCompletionResult?.(nativeResult)).toBe(true);
    expect(
      openCode.isChildCompletionResult?.({
        ...nativeResult,
        name: "builtin:task",
      }),
    ).toBe(true);

    // The spawn prompt lives only behind a natively-spelled task call.
    expect(
      openCode.spawnPromptField("functions.task", { prompt: "p" }),
    ).toBeUndefined();
    expect(
      openCode.spawnPromptField("host/claude-code/task", { prompt: "p" }),
    ).toBeUndefined();
  });

  test("keeps Chat child-incapable", () => {
    expect(chat.isSpawnTool("task")).toBe(false);
    expect(
      chat.namesChildren({ rootId: "c", arguments: { task_id: "x" } }),
    ).toEqual([]);
    expect(
      chat.bindChildTrajectory({
        headers: { "x-appa-parent-id": "parent" },
        requestBody: {},
      }),
    ).toBeUndefined();
  });

  test("Claude Code names_children matches minted child ids for documented files", () => {
    expect(claudeCode.childTranscriptPaths).toEqual([
      { prefix: "tasks/", suffix: ".output" },
      { prefix: "subagents/agent-", suffix: ".jsonl" },
    ]);
    expect(
      claudeCode.namesChildren({
        rootId: "s1",
        arguments: { prompt: "list files" },
      }),
    ).toEqual([]);
    expect(
      claudeCode.namesChildren({
        rootId: "s1",
        arguments: {
          command:
            "cat tasks/a1.output; grep x subagents/agent-a2.jsonl tasks/a1.output",
        },
      }),
    ).toEqual(["s1:a1", "s1:a2"]);
    expect(
      claudeCode.namesChildren({
        rootId: "s1",
        arguments: {
          file_path: "/home/u/.claude/subagents/agent-b7.jsonl",
          meta: [{ p: "tasks/x-1.output" }],
        },
      }),
    ).toEqual(["s1:b7", "s1:x-1"]);
    expect(
      claudeCode.namesChildren({
        rootId: "s1",
        arguments: { file_path: "tasks/a1.txt" },
      }),
    ).toEqual([]);
    expect(
      claudeCode.namesChildren({
        rootId: "s1:a1",
        arguments: { file_path: "tasks/a1.output" },
      }),
    ).toEqual([]);
  });

  test("Claude Code path tokens that only contain the spelling name no child", () => {
    for (const path of [
      "mytasks/a1.output",
      "tasks/a1.output.bak",
      "notes/tasks/a1.outputs",
      "mysubagents/agent-a1.jsonl",
      "subagents/agent-a1.jsonl.gz",
      "backup-subagents/agent-a1.jsonl",
    ]) {
      expect(
        claudeCode.namesChildren({
          rootId: "s1",
          arguments: { file_path: path },
        }),
      ).toEqual([]);
    }
  });

  test("matches transcript path prefixes only at path segment boundaries", () => {
    const pathPatterns = [{ prefix: "tasks/", suffix: ".output" }];
    expect(
      referencesChildTranscriptPath({
        arguments: { file_path: "/home/u/.claude/tasks/a1.output" },
        pathPatterns,
      }),
    ).toBe(true);
    expect(
      referencesChildTranscriptPath({
        arguments: { file_path: "/home/u/.claude/mytasks/a1.output" },
        pathPatterns,
      }),
    ).toBe(false);
  });

  test("Codex and OpenCode name children from spawn/resume identity fields", () => {
    expect(
      codex.namesChildren({
        rootId: "thread-parent",
        arguments: { agent_id: "thread-child" },
      }),
    ).toEqual(["thread-parent:thread-child"]);
    expect(
      codex.namesChildren({
        rootId: "t0:t1:t2",
        arguments: {
          receiver_thread_id: "t0",
          thread_id: "t1",
          agent_id: "t3",
        },
      }),
    ).toEqual(["t0:t1:t2:t3"]);
    expect(
      codex.namesChildren({
        rootId: "thread-parent",
        arguments: { agent_id: "thread-parent", thread_id: "thread-child" },
      }),
    ).toEqual(["thread-parent:thread-child"]);
    expect(
      openCode.namesChildren({
        rootId: "sess-parent",
        arguments: { task_id: "sess-child" },
      }),
    ).toEqual(["sess-parent:sess-child"]);
  });

  test("strips Claude Code child carrier fields from the provider body", () => {
    const request = {
      metadata: {
        agent_id: "a1",
        user_id: JSON.stringify({ session_id: "s1", agent_id: "a1" }),
      },
    };
    claudeCode.stripCarrierMetadata(request);
    expect(request.metadata.agent_id).toBeUndefined();
    expect(JSON.parse(request.metadata.user_id)).toEqual({ session_id: "s1" });
  });

  test("strips Codex child carrier objects from the provider body", () => {
    const request = {
      client_metadata: {
        thread_id: "t1",
        "x-codex-turn-metadata": {
          thread_id: "t1",
          parent_thread_id: "t0",
        },
      },
      metadata: {
        thread_id: "t1",
        "x-codex-parent-thread-id": "t0",
      },
    };

    codex.stripCarrierMetadata(request);

    expect(request.client_metadata).toEqual({ thread_id: "t1" });
    expect(request.metadata).toEqual({ thread_id: "t1" });
  });

  test("mints Claude Code child ids from agent_id under the native parent session", () => {
    expect(
      claudeCode.bindChildTrajectory({
        headers: {
          "x-claude-code-session-id": "s1",
          "x-claude-code-agent-id": "a1",
        },
        requestBody: {},
      }),
    ).toEqual({
      sessionId: "s1:a1",
      parentId: "s1",
      lineage: { source: "native", nativeParentId: "s1", childNativeId: "a1" },
    });
  });

  test("uses only an authentic delegation marker as a marker-only Claude child id", () => {
    config.openappa.offerSigningSecret = SECRET;
    const authentic = delegated({
      headers: { "x-claude-code-session-id": "s1" },
      interactionType: "anthropic:messages",
      body: {
        messages: [
          {
            role: "user",
            content: opening({
              parentId: "s1",
              spawner: "s1",
              spawnCallId: "spawn-call",
            }),
          },
        ],
      },
    });
    expect(claudeCode.bindChildTrajectory(authentic)).toEqual({
      sessionId: "s1:spawn-call",
      parentId: "s1",
      lineage: {
        source: "marker",
        nativeParentId: "s1",
        spawnCallId: "spawn-call",
      },
    });
    expect(claudeCode.nativeSpawnParentId?.(authentic, "s1")).toBe("s1");

    const forgedCallId = "forged-spawn";
    const forged = delegated({
      headers: { "x-claude-code-session-id": "s1" },
      interactionType: "anthropic:messages",
      body: {
        messages: [
          {
            role: "user",
            content: `${PROMPT}\n\n[appa] delegated trajectory appa2-${Buffer.from(forgedCallId).toString("base64url")}.${"0".repeat(40)} — child of s1.`,
          },
        ],
      },
    });
    expect(forged.trustedContext?.request.delegation?.markers).toHaveLength(1);
    expect(claudeCode.bindChildTrajectory(forged)).toBeUndefined();
  });

  test("mints Codex child ids from turn metadata under the parent thread", () => {
    expect(
      codex.bindChildTrajectory({
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            parent_thread_id: "thread-parent",
            agent_id: "thread-child",
          }),
        },
        requestBody: {},
      }),
    ).toMatchObject({
      sessionId: "thread-parent:thread-child",
      parentId: "thread-parent",
    });
  });

  test("mints OpenCode child ids from the child session under the parent session", () => {
    const context = {
      headers: {
        "x-opencode-session": "sess-child",
        "x-session-id": "sess-parent",
      },
      requestBody: {},
    };
    expect(openCode.extractSessionIdentity(context)).toMatchObject({
      sessionId: "sess-child",
      provenance: "opencode-hosted-header",
    });
    expect(openCode.bindChildTrajectory(context)).toMatchObject({
      sessionId: "sess-parent:sess-child",
      parentId: "sess-parent",
    });
    expect(
      openCode.bindChildTrajectory({
        headers: {
          "user-agent": "opencode/1.18.31",
          "x-session-id": "sess-child",
          "x-parent-session-id": "sess-parent",
        },
        requestBody: {},
      }),
    ).toMatchObject({
      sessionId: "sess-parent:sess-child",
      parentId: "sess-parent",
    });
  });

  test("leaves ordinary Codex and OpenCode roots unbound without a parent", () => {
    expect(
      codex.bindChildTrajectory({
        headers: { "user-agent": "codex_cli_rs/0.99.0" },
        requestBody: { client_metadata: { thread_id: "codex-root" } },
      }),
    ).toBeUndefined();
    expect(
      openCode.bindChildTrajectory({
        headers: {
          "user-agent": "opencode/1.18.31",
          "x-opencode-session": "opencode-root",
        },
        requestBody: {},
      }),
    ).toBeUndefined();
  });

  test("rejects absent, duplicate, reused, and cross-parent correlation headers", () => {
    expect(() =>
      claudeCode.bindChildTrajectory({
        headers: {
          "x-claude-code-agent-id": "a1",
          "x-appa-parent-id": "s1",
        },
        requestBody: {},
      }),
    ).toThrow(ApiError);

    expect(() =>
      claudeCode.bindChildTrajectory({
        headers: {
          "x-claude-code-session-id": "s1",
          "x-claude-code-agent-id": "s1",
        },
        requestBody: {},
      }),
    ).toThrow(ApiError);

    expect(() =>
      claudeCode.bindChildTrajectory({
        headers: {
          "x-claude-code-session-id": "s1",
          "x-claude-code-agent-id": "a1",
          "x-appa-parent-id": "other-root",
        },
        requestBody: {},
      }),
    ).toThrow(ApiError);

    expect(() =>
      claudeCode.bindChildTrajectory({
        headers: {
          "x-claude-code-session-id": "s1",
          "x-claude-code-agent-id": "a1",
          "x-appa-session-id": "s1:other",
        },
        requestBody: {},
      }),
    ).toThrow(ApiError);

    expect(() =>
      claudeCode.bindChildTrajectory({
        headers: { "x-appa-parent-id": "s1" },
        requestBody: {},
      }),
    ).toThrow(ApiError);

    expect(() =>
      codex.bindChildTrajectory({
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            parent_thread_id: "thread-parent",
            agent_id: "thread-child",
          }),
          "x-appa-parent-id": "other-root",
        },
        requestBody: {},
      }),
    ).toThrow(ApiError);

    expect(() =>
      openCode.bindChildTrajectory({
        headers: {
          "x-opencode-session": "sess-child",
          "x-session-id": "sess-parent",
          "x-appa-parent-id": "other-root",
        },
        requestBody: {},
      }),
    ).toThrow(ApiError);
  });

  test("names where each client's spawn prompt lives, and no prompt for a skill", () => {
    expect(claudeCode.spawnPromptField("Agent", { prompt: "p" })).toEqual({
      field: "prompt",
      kind: "text",
    });
    expect(claudeCode.spawnPromptField("Task", { prompt: "p" })).toEqual({
      field: "prompt",
      kind: "text",
    });
    // A skill runs in the spawner's own trajectory.
    expect(
      claudeCode.spawnPromptField("Skill", { skill: "x" }),
    ).toBeUndefined();
    expect(
      claudeCode.spawnPromptField("Bash", { command: "ls" }),
    ).toBeUndefined();

    expect(openCode.spawnPromptField("task", { prompt: "p" })).toEqual({
      field: "prompt",
      kind: "text",
    });
    expect(openCode.spawnPromptField("skill", { name: "x" })).toBeUndefined();

    // Codex takes a message or input items, never both.
    expect(codex.spawnPromptField("spawn_agent", { message: "p" })).toEqual({
      field: "message",
      kind: "text",
    });
    expect(
      codex.spawnPromptField("spawn_agent", {
        items: [{ type: "text", text: "p" }],
      }),
    ).toEqual({ field: "items", kind: "items" });
    expect(codex.spawnPromptField("spawn_agent", { message: " " })).toBe(
      undefined,
    );
    expect(codex.spawnPromptField("send_message", { message: "p" })).toBe(
      undefined,
    );

    expect(chat.spawnPromptField("task", {})).toBeUndefined();
  });

  test("reads the native id each client's children report as their parent", () => {
    expect(
      claudeCode.nativeConversationId({
        headers: {
          "x-claude-code-session-id": "s1",
          "x-claude-code-agent-id": "a1",
        },
        requestBody: {},
      }),
    ).toBe("s1");
    expect(
      codex.nativeConversationId({
        headers: {
          "x-codex-turn-metadata": JSON.stringify({
            parent_thread_id: "t0",
            thread_id: "t1",
          }),
        },
        requestBody: { prompt_cache_key: "t1" },
      }),
    ).toBe("t1");
    expect(
      codex.nativeConversationId({
        headers: {},
        requestBody: { prompt_cache_key: "t0" },
      }),
    ).toBe("t0");
    expect(
      openCode.nativeConversationId({
        headers: {
          "user-agent": "opencode/1.18.31",
          "x-session-id": "sess-child",
          "x-parent-session-id": "sess-parent",
        },
        requestBody: {},
      }),
    ).toBe("sess-child");
    expect(
      chat.nativeConversationId({ headers: {}, requestBody: {} }),
    ).toBeUndefined();
  });

  test("binds a grandchild under the lineage its delegation marker names", () => {
    config.openappa.offerSigningSecret = SECRET;
    // Claude Code reports only the session at every depth; the marker names
    // the child that spawned this one.
    expect(
      claudeCode.bindChildTrajectory(
        delegated({
          headers: {
            "x-claude-code-session-id": "s1",
            "x-claude-code-agent-id": "g1",
          },
          interactionType: "anthropic:messages",
          body: {
            messages: [
              {
                role: "user",
                content: opening({ parentId: "s1:a1", spawner: "s1" }),
              },
            ],
          },
        }),
      ),
    ).toEqual({
      sessionId: "s1:a1:g1",
      parentId: "s1:a1",
      lineage: { source: "marker", nativeParentId: "s1", childNativeId: "g1" },
    });

    // Codex reports only the immediate parent's thread.
    expect(
      codex.bindChildTrajectory(
        delegated({
          headers: {
            "x-codex-turn-metadata": JSON.stringify({
              parent_thread_id: "t1",
              thread_id: "t2",
            }),
          },
          interactionType: "openai:responses",
          body: {
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: opening({ parentId: "t0:t1", spawner: "t1" }),
                  },
                ],
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ sessionId: "t0:t1:t2", parentId: "t0:t1" });

    expect(
      openCode.bindChildTrajectory(
        delegated({
          headers: {
            "user-agent": "opencode/1.18.31",
            "x-session-id": "g",
            "x-parent-session-id": "c",
          },
          interactionType: "openai:chatCompletions",
          body: {
            messages: [
              { role: "system", content: "You are a subagent." },
              {
                role: "user",
                content: opening({ parentId: "p:c", spawner: "c" }),
              },
            ],
          },
        }),
      ),
    ).toMatchObject({ sessionId: "p:c:g", parentId: "p:c" });
  });

  test("binds a grandchild from a child trajectory receipt after the opening prompt is gone", () => {
    config.openappa.offerSigningSecret = SECRET;
    const footer = mintChildTrajectoryReceipt({
      organizationId: "org",
      callerId: "user:user",
      parentId: "s1:a1",
      childId: "s1:a1:g1",
      childNativeId: "g1",
      spawnerNativeId: "s1",
    });
    expect(
      claudeCode.bindChildTrajectory(
        delegated({
          headers: {
            "x-claude-code-session-id": "s1",
            "x-claude-code-agent-id": "g1",
          },
          interactionType: "anthropic:messages",
          body: {
            messages: [
              { role: "assistant", content: `${footer}\n\nok` },
              {
                role: "user",
                content: "Summary of the conversation so far.",
              },
            ],
          },
        }),
      ),
    ).toEqual({
      sessionId: "s1:a1:g1",
      parentId: "s1:a1",
      lineage: {
        source: "receipt",
        nativeParentId: "s1",
        childNativeId: "g1",
      },
    });
  });

  test("recovers Codex and OpenCode parents only from signed compacted proofs", () => {
    config.openappa.offerSigningSecret = SECRET;
    const codexFooter = mintChildTrajectoryReceipt({
      organizationId: "org",
      callerId: "user:user",
      parentId: "t0",
      childId: "t0:t1",
      childNativeId: "t1",
      spawnerNativeId: "t0",
      spawnCallId: "spawn-codex",
    });
    const codexContext = delegated({
      headers: { "user-agent": "codex_cli_rs/0.99.0" },
      interactionType: "openai:responses",
      body: {
        client_metadata: { agent_id: "t1" },
        input: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: `${codexFooter}\n\nok` }],
          },
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "Summary of the conversation so far.",
              },
            ],
          },
        ],
      },
    });
    expect(JSON.stringify(codexContext.requestBody)).not.toContain("appact2-");
    expect(codex.bindChildTrajectory(codexContext)).toEqual({
      sessionId: "t0:t1",
      parentId: "t0",
      lineage: {
        source: "receipt",
        nativeParentId: "t0",
        childNativeId: "t1",
        spawnCallId: "spawn-codex",
      },
    });

    const openCodeFooter = mintChildTrajectoryReceipt({
      organizationId: "org",
      callerId: "user:user",
      parentId: "p",
      childId: "p:c",
      childNativeId: "c",
      spawnerNativeId: "p",
      spawnCallId: "spawn-opencode",
    });
    const openCodeContext = delegated({
      headers: {
        "user-agent": "opencode/1.18.31",
        "x-opencode-session": "c",
      },
      interactionType: "openai:chatCompletions",
      body: {
        messages: [
          { role: "assistant", content: `${openCodeFooter}\n\nok` },
          { role: "user", content: "Summary of the conversation so far." },
        ],
      },
    });
    expect(JSON.stringify(openCodeContext.requestBody)).not.toContain(
      "appact2-",
    );
    expect(openCode.bindChildTrajectory(openCodeContext)).toEqual({
      sessionId: "p:c",
      parentId: "p",
      lineage: {
        source: "receipt",
        nativeParentId: "p",
        childNativeId: "c",
        spawnCallId: "spawn-opencode",
      },
    });
  });

  test("preserves a marker-only Claude child across compaction and later native metadata", () => {
    config.openappa.offerSigningSecret = SECRET;
    const started = claudeCode.bindChildTrajectory(
      delegated({
        headers: { "x-claude-code-session-id": "s1" },
        interactionType: "anthropic:messages",
        body: {
          messages: [
            {
              role: "user",
              content: opening({
                parentId: "s1",
                spawner: "s1",
                spawnCallId: "spawn-call",
              }),
            },
          ],
        },
      }),
    );
    expect(started).toEqual({
      sessionId: "s1:spawn-call",
      parentId: "s1",
      lineage: {
        source: "marker",
        nativeParentId: "s1",
        spawnCallId: "spawn-call",
      },
    });

    const footer = mintChildTrajectoryReceipt({
      organizationId: "org",
      callerId: "user:user",
      parentId: "s1",
      childId: "s1:spawn-call",
      spawnerNativeId: "s1",
      spawnCallId: "spawn-call",
    });
    const compactedBody = {
      messages: [
        { role: "assistant", content: `${footer}\n\nok` },
        { role: "user", content: "Summary of the conversation so far." },
      ],
    };
    expect(
      claudeCode.bindChildTrajectory(
        delegated({
          headers: { "x-claude-code-session-id": "s1" },
          interactionType: "anthropic:messages",
          body: structuredClone(compactedBody),
        }),
      ),
    ).toEqual({
      sessionId: "s1:spawn-call",
      parentId: "s1",
      lineage: {
        source: "receipt",
        nativeParentId: "s1",
        spawnCallId: "spawn-call",
      },
    });
    expect(
      claudeCode.bindChildTrajectory(
        delegated({
          headers: {},
          interactionType: "anthropic:messages",
          body: structuredClone(compactedBody),
        }),
      ),
    ).toEqual({
      sessionId: "s1:spawn-call",
      parentId: "s1",
      lineage: {
        source: "receipt",
        nativeParentId: "s1",
        spawnCallId: "spawn-call",
      },
    });
    expect(
      claudeCode.bindChildTrajectory(
        delegated({
          headers: {
            "x-claude-code-session-id": "s1",
            "x-claude-code-agent-id": "a1",
          },
          interactionType: "anthropic:messages",
          body: structuredClone(compactedBody),
        }),
      ),
    ).toEqual({
      sessionId: "s1:spawn-call",
      parentId: "s1",
      lineage: {
        source: "receipt",
        nativeParentId: "s1",
        childNativeId: "a1",
        spawnCallId: "spawn-call",
      },
    });
  });
});

const SECRET = "adapter-test-secret-0123456789abcdef";
const PROMPT = "Look into the flaky test.";

/** A child's opening text: the spawn prompt and the marker APPA appended. */
function opening(params: {
  parentId: string;
  spawner: string;
  spawnCallId?: string;
}): string {
  const marker = mintDelegationMarker({
    organizationId: "org",
    callerId: "user:user",
    parentId: params.parentId,
    spawnerNativeId: params.spawner,
    prompt: PROMPT,
    spawnCallId: params.spawnCallId,
  });
  return `${PROMPT}\n\n${marker}`;
}

/** A match context whose trusted request read the body's markers. */
function delegated(params: {
  headers: Record<string, string>;
  interactionType: string;
  body: unknown;
}): AppaMatchContext {
  return {
    headers: params.headers,
    requestBody: params.body,
    trustedContext: {
      session: {
        organization_id: "org",
        caller_id: "user:user",
        session_id: "user:user|root",
      },
      profileId: "profile",
      toolIdentity: {
        canonicalize: (name) => name,
        attestationOf: () => undefined,
        looseRunToolDispatch: false,
      },
      request: prepareAppaRequest({
        body: params.body,
        interactionType: params.interactionType,
        identity: {
          mode: "compat",
          gatewayConnected: true,
          canonicalize: (name) => name,
          attestationOf: () => undefined,
          verified: [],
          unverifiedMarkerCount: 0,
        },
      }),
    },
  };
}
