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

describe("plugin content", () => {
  const file = (path: string, content: string) => ({
    path,
    content,
    encoding: "utf8" as const,
    mode: "100644" as const,
  });

  test("rejects a plugin whose files are all blank", () => {
    const result = CreatePluginSchema.safeParse({
      ...base,
      files: [file("hooks/hooks.json", ""), file("README.md", "  \n")],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "At least one file must have content",
    );
  });

  test("accepts a blank file beside one that has content", () => {
    const result = CreatePluginSchema.safeParse({
      ...base,
      files: [file("hooks/hooks.json", "{}"), file("notes/.keep", "")],
    });
    expect(result.success).toBe(true);
  });
});
