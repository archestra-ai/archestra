import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { expect, test } from "vitest";
import { loadSessionHistory, saveSessionHistory } from "./session-history.js";

test("restores saved model context and refuses malformed retained state", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "agent-history-"));
  try {
    expect(await loadSessionHistory(runtimeDir)).toEqual([]);
    const messages: ModelMessage[] = [
      { role: "user", content: "Remember the selected branch" },
      { role: "assistant", content: "feature/example" },
    ];
    await saveSessionHistory({ runtimeDir, messages });
    expect(await loadSessionHistory(runtimeDir)).toEqual(messages);
    const transcriptMessages: ModelMessage[] = [
      ...messages,
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "interrupted",
            toolName: "shell",
            input: { command: "sleep 60" },
          },
        ],
      },
      { role: "assistant", content: "Turn interrupted by the user." },
    ];
    await saveSessionHistory({ runtimeDir, messages, transcriptMessages });
    expect(await loadSessionHistory(runtimeDir)).toEqual(messages);
    expect(await loadSessionHistory(runtimeDir, "transcript")).toEqual(
      transcriptMessages,
    );
    // Existing workspaces stored only a model-message array.
    await writeFile(
      join(runtimeDir, "agent-session.json"),
      JSON.stringify(messages),
    );
    expect(await loadSessionHistory(runtimeDir, "transcript")).toEqual(
      messages,
    );
    await writeFile(join(runtimeDir, "agent-session.json"), "{}");
    await expect(loadSessionHistory(runtimeDir)).rejects.toThrow(
      "retained Agent session is invalid",
    );
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
