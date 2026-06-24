import { describe, expect, it } from "vitest";

import {
  isScheduledRunConversation,
  scheduledRunContext,
} from "./scheduled-run-sidebar.utils";

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

describe("scheduledRunContext", () => {
  it("returns { triggerId, runId } when both params present", () => {
    const params = new URLSearchParams("scheduleTriggerId=t1&scheduleRunId=r1");
    expect(scheduledRunContext(params)).toEqual({
      triggerId: "t1",
      runId: "r1",
    });
  });

  it("returns { triggerId, runId: null } when only triggerId present", () => {
    const params = new URLSearchParams("scheduleTriggerId=t1");
    expect(scheduledRunContext(params)).toEqual({
      triggerId: "t1",
      runId: null,
    });
  });

  it("returns null when no params present", () => {
    const params = new URLSearchParams("");
    expect(scheduledRunContext(params)).toBeNull();
  });

  it("returns null when only runId present (no triggerId)", () => {
    const params = new URLSearchParams("scheduleRunId=r1");
    expect(scheduledRunContext(params)).toBeNull();
  });

  it("returns null when triggerId is empty string", () => {
    const params = new URLSearchParams("scheduleTriggerId=");
    expect(scheduledRunContext(params)).toBeNull();
  });
});
