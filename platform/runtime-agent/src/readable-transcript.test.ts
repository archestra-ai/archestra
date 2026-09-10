import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelMessage } from "ai";
import { afterEach, describe, expect, test } from "vitest";
import { writeReadableTranscript } from "./readable-transcript.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("writeReadableTranscript", () => {
  test("settles unfinished tool calls when an interrupted turn becomes idle", async () => {
    const runtimeDir = await mkdtemp(
      path.join(tmpdir(), "archestra-transcript-"),
    );
    temporaryDirectories.push(runtimeDir);
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolName: "run_command",
            toolCallId: "sleep",
            input: { command: "sleep 90" },
          },
        ],
      },
    ];
    await writeReadableTranscript({
      runtimeDir,
      messages,
      sessionState: "working",
    });
    const read = async () =>
      JSON.parse(
        await readFile(
          path.join(runtimeDir, "readable-transcript.json"),
          "utf8",
        ),
      );
    expect((await read()).entries).toHaveLength(1);
    await writeReadableTranscript({
      runtimeDir,
      messages,
      sessionState: "idle",
    });
    expect((await read()).entries.at(-1)).toMatchObject({
      type: "tool_result",
      toolCallId: "sleep",
      isError: true,
    });
  });

  test.each([
    undefined,
    null,
    {},
    { type: "text", value: null },
    { type: "content", value: null },
    { type: "future-output", value: {} },
  ])("preserves history around malformed tool output %j", async (output) => {
    const runtimeDir = await mkdtemp(
      path.join(tmpdir(), "archestra-transcript-"),
    );
    temporaryDirectories.push(runtimeDir);
    const messages = [
      { role: "user", content: "Before" },
      ...["tool", "assistant"].map((role) => ({
        role,
        content: [
          {
            type: "tool-result",
            toolName: "test",
            toolCallId: "call-1",
            output,
          },
        ],
      })),
      { role: "assistant", content: "After" },
    ] as unknown as ModelMessage[];
    await writeReadableTranscript({ runtimeDir, messages });
    const transcript = JSON.parse(
      await readFile(path.join(runtimeDir, "readable-transcript.json"), "utf8"),
    );
    expect(
      transcript.entries.map((entry: { text: string }) => entry.text),
    ).toEqual([
      "Before",
      "[Unrecognized tool result omitted]",
      "[Unrecognized tool result omitted]",
      "After",
    ]);
  });

  test("preserves user, assistant, tool call, and tool result history", async () => {
    const runtimeDir = await mkdtemp(
      path.join(tmpdir(), "archestra-transcript-"),
    );
    temporaryDirectories.push(runtimeDir);
    const messages: ModelMessage[] = [
      { role: "user", content: "Inspect the file." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect it." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: "src/app.ts" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: { type: "text", value: "export const ready = true;" },
          },
        ],
      },
      { role: "assistant", content: "The file is ready." },
    ];

    await writeReadableTranscript({ messages, runtimeDir });

    expect(
      JSON.parse(
        await readFile(
          path.join(runtimeDir, "readable-transcript.json"),
          "utf8",
        ),
      ),
    ).toEqual({
      version: 1,
      provider: "archestra-agent",
      entries: [
        { type: "message", role: "user", text: "Inspect the file." },
        { type: "message", role: "assistant", text: "I will inspect it." },
        {
          type: "tool_call",
          name: "read_file",
          input: '{"path":"src/app.ts"}',
          toolCallId: "call-1",
        },
        {
          type: "tool_result",
          text: "export const ready = true;",
          toolCallId: "call-1",
        },
        { type: "message", role: "assistant", text: "The file is ready." },
      ],
    });
  });
});
