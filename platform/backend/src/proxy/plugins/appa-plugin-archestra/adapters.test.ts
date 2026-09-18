import { describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { AppaChatAdapter } from "./adapters/chat";
import { AppaClaudeCodeAdapter } from "./adapters/claude-code";
import { AppaCodexAdapter } from "./adapters/codex";
import { AppaOpenCodeAdapter } from "./adapters/opencode";

describe("APPA child trajectory adapters", () => {
  const claudeCode = new AppaClaudeCodeAdapter();
  const codex = new AppaCodexAdapter();
  const openCode = new AppaOpenCodeAdapter();
  const chat = new AppaChatAdapter();

  test("classifies Claude Code Agent and Task as spawn, not Skill or Bash", () => {
    expect(claudeCode.isSpawnTool("Agent")).toBe(true);
    expect(claudeCode.isSpawnTool("Task")).toBe(true);
    expect(claudeCode.isSpawnTool("host/claude-code/Agent")).toBe(true);
    expect(claudeCode.isSpawnTool("Skill")).toBe(false);
    expect(claudeCode.isSpawnTool("Bash")).toBe(false);
  });

  test("classifies Codex spawn_agent as spawn, not wait or resume", () => {
    expect(codex.isSpawnTool("spawn_agent")).toBe(true);
    expect(codex.isSpawnTool("functions.spawn_agent")).toBe(true);
    expect(codex.isSpawnTool("builtin:spawn_agent")).toBe(true);
    expect(codex.isSpawnTool("wait_agent")).toBe(false);
    expect(codex.isSpawnTool("resume_agent")).toBe(false);
  });

  test("classifies OpenCode task as spawn, not skill or bash", () => {
    expect(openCode.isSpawnTool("task")).toBe(true);
    expect(openCode.isSpawnTool("builtin:task")).toBe(true);
    expect(openCode.isSpawnTool("skill")).toBe(false);
    expect(openCode.isSpawnTool("bash")).toBe(false);
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

  test("Codex and OpenCode name children from spawn/resume identity fields", () => {
    expect(
      codex.namesChildren({
        rootId: "thread-parent",
        arguments: { agent_id: "thread-child" },
      }),
    ).toEqual(["thread-parent:thread-child"]);
    expect(
      openCode.namesChildren({
        rootId: "sess-parent",
        arguments: { task_id: "sess-child" },
      }),
    ).toEqual(["sess-parent:sess-child"]);
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
    ).toEqual({ sessionId: "s1:a1", parentId: "s1" });
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
    ).toEqual({
      sessionId: "thread-parent:thread-child",
      parentId: "thread-parent",
    });
  });

  test("mints OpenCode child ids from the child session under the parent session", () => {
    expect(
      openCode.bindChildTrajectory({
        headers: {
          "x-opencode-session": "sess-child",
          "x-session-id": "sess-parent",
        },
        requestBody: {},
      }),
    ).toEqual({
      sessionId: "sess-parent:sess-child",
      parentId: "sess-parent",
    });
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
  });
});
