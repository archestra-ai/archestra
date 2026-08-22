import { describe, expect, test } from "vitest";
import { CreatePluginSchema, PLUGIN_MAX_FILE_BYTES } from "./plugin";

const base = {
  displayName: "Sized plugin",
  description: "",
  clientType: "claude-code" as const,
};

describe("plugin byte limits", () => {
  test("rejects a file over the decoded-byte limit", () => {
    const result = CreatePluginSchema.safeParse({
      ...base,
      files: [
        {
          path: "hooks/hooks.json",
          content: "x".repeat(PLUGIN_MAX_FILE_BYTES + 1),
          encoding: "utf8",
          mode: "100644",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("rejects a plugin whose individually valid files exceed the total", () => {
    const content = "x".repeat(700 * 1024);
    const result = CreatePluginSchema.safeParse({
      ...base,
      files: Array.from({ length: 8 }, (_, index) => ({
        path: index === 0 ? "hooks/hooks.json" : `assets/${index}.txt`,
        content,
        encoding: "utf8",
        mode: "100644",
      })),
    });
    expect(result.success).toBe(false);
  });
});
