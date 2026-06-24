import { describe, expect, it } from "vitest";

import { isScheduledRunConversation } from "./scheduled-run-sidebar.utils";

describe("isScheduledRunConversation", () => {
  it("returns true for schedule_trigger origin", () => {
    expect(isScheduledRunConversation({ origin: "schedule_trigger" })).toBe(
      true,
    );
  });

  it("returns false for user origin", () => {
    expect(isScheduledRunConversation({ origin: "user" })).toBe(false);
  });

  it("returns false for unknown origin string", () => {
    expect(isScheduledRunConversation({ origin: "other" })).toBe(false);
  });
});
