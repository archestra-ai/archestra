// @vitest-environment node
import { expect, test } from "vitest";
import { isDeliverablePlugin } from "./plugin-eligibility";

test("Grok cannot deliver Claude plugins, while approved native-client delivery is unchanged", () => {
  const approved = {
    clientType: "claude-code" as const,
    enabled: true,
    approvedContentHash: "synthetic",
    contentHash: "synthetic",
  };
  expect(isDeliverablePlugin(approved, "grok-build")).toBe(false);
  expect(isDeliverablePlugin(approved, "claude-code")).toBe(true);
  expect(
    isDeliverablePlugin({ ...approved, contentHash: "changed" }, "claude-code"),
  ).toBe(false);
});
