import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ModelMessage } from "ai";

/** Native conversation state is separate from the per-turn readable artifact. */
export async function loadSessionHistory(
  runtimeDir: string,
): Promise<ModelMessage[]> {
  let contents: string;
  try {
    contents = await readFile(join(runtimeDir, "agent-session.json"), "utf8");
  } catch (error) {
    // A cancelled first turn may never have completed a model step.
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return [];
    throw error;
  }
  const value: unknown = JSON.parse(contents);
  if (
    !Array.isArray(value) ||
    !value.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        ["user", "assistant", "tool", "system"].includes(entry.role) &&
        "content" in entry,
    )
  ) {
    throw new Error("The retained Agent session is invalid");
  }
  return value as ModelMessage[];
}

export async function saveSessionHistory(params: {
  runtimeDir: string;
  messages: ModelMessage[];
}): Promise<void> {
  const path = join(params.runtimeDir, "agent-session.json");
  await writeFile(`${path}.tmp`, JSON.stringify(params.messages), {
    mode: 0o600,
  });
  await rename(`${path}.tmp`, path);
}
