import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "ai";
import { expect, test } from "vitest";
import { loadSessionHistory, saveSessionHistory } from "./session-history.js";

test("restores saved model context and refuses malformed retained state", async () => {
  const runtimeDir = await mkdtemp(join(tmpdir(), "agent-history-"));
  try {
    const messages: ModelMessage[] = [
      { role: "user", content: "Remember the selected branch" },
      { role: "assistant", content: "feature/example" },
    ];
    await saveSessionHistory({ runtimeDir, messages });
    expect(await loadSessionHistory(runtimeDir)).toEqual(messages);
    await writeFile(join(runtimeDir, "agent-session.json"), "{}");
    await expect(loadSessionHistory(runtimeDir)).rejects.toThrow(
      "retained Agent session is invalid",
    );
  } finally {
    await rm(runtimeDir, { recursive: true, force: true });
  }
});
