import { describe, expect, test } from "vitest";
import {
  CLIENT_FILTER_OPTIONS,
  ClientFilterSchema,
  clientFilterToAgentIds,
  clientForExternalAgentIds,
  isOpenCodeClientAgentId,
  OPENCODE_CLIENT_ID,
} from "./client";

describe("OpenCode client attribution", () => {
  test("orders filters like the connection page", () => {
    expect(CLIENT_FILTER_OPTIONS.map(({ value }) => value)).toEqual([
      "claude-code",
      "claude-desktop",
      "cursor",
      "codex",
      "opencode",
      "copilot-cli",
    ]);
  });

  test("normalizes stored client ids and resolves the UI family", () => {
    expect(isOpenCodeClientAgentId("  OpenCode ")).toBe(true);
    expect(
      clientForExternalAgentIds(["unrelated", " OPENCODE "]),
    ).toMatchObject({
      filter: "opencode",
      label: "OpenCode",
      icon: "/icons/opencode.png",
    });
  });

  test("exposes a filter that expands to the persisted attribution id", () => {
    expect(ClientFilterSchema.parse("opencode")).toBe("opencode");
    expect(clientFilterToAgentIds("opencode")).toEqual([OPENCODE_CLIENT_ID]);
    expect(CLIENT_FILTER_OPTIONS).toContainEqual(
      expect.objectContaining({
        value: "opencode",
        label: "OpenCode",
        icon: "/icons/opencode.png",
      }),
    );
  });
});
