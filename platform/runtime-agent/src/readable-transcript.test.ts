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
