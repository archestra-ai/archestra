import { describe, expect, it } from "vitest";
import {
  buildCronFromSchedule,
  buildScheduleTriggerPayload,
  DEFAULT_FORM_STATE,
  isValidCronExpression,
  parseCronToMode,
} from "./schedule-trigger.utils";

describe("parseCronToMode", () => {
  it("maps a plain hourly expression to the hourly preset", () => {
    expect(parseCronToMode("0 * * * *").mode).toBe("hourly");
  });

  it("maps a daily weekday expression to the daily preset", () => {
    expect(parseCronToMode("0 9 * * 1-5")).toEqual({
      mode: "daily",
      hour: "9",
      minute: "0",
      days: [1, 2, 3, 4, 5],
    });
  });

  it("expands a daily wildcard weekday to all seven days", () => {
    expect(parseCronToMode("30 8 * * *")).toEqual({
      mode: "daily",
      hour: "8",
      minute: "30",
      days: [0, 1, 2, 3, 4, 5, 6],
    });
  });

  it("parses comma-separated weekdays for the daily preset", () => {
    expect(parseCronToMode("0 9 * * 1,3,5").days).toEqual([1, 3, 5]);
  });

  it.each([
    ["a stepped minute", "*/15 * * * *"],
    ["a stepped hour", "0 */2 * * *"],
    ["a day-of-month constraint", "0 9 1 * *"],
    ["a month constraint", "0 9 * 6 *"],
    ["a stepped weekday", "0 9 * * */2"],
    ["a six-field expression", "0 0 9 * * 1-5"],
    ["a non-numeric field", "0 9 * * MON"],
  ])("routes %s to the custom tab", (_label, expression) => {
    expect(parseCronToMode(expression).mode).toBe("custom");
  });

  it("round-trips daily and hourly presets through buildCronFromSchedule", () => {
    for (const expression of ["0 * * * *", "0 9 * * 1-5", "30 8 * * *"]) {
      const parsed = parseCronToMode(expression);
      // `custom` is never produced for these inputs, so the cast is safe.
      const rebuilt = buildCronFromSchedule(
        parsed.mode as "hourly" | "daily",
        parsed.hour,
        parsed.minute,
        parsed.days,
      );
      expect(parseCronToMode(rebuilt).mode).toBe(parsed.mode);
    }
  });
});

describe("buildCronFromSchedule", () => {
  it("builds an hourly expression at the given minute", () => {
    expect(buildCronFromSchedule("hourly", "9", "0", [1, 2])).toBe("0 * * * *");
  });

  it("collapses a full week to a wildcard weekday", () => {
    expect(
      buildCronFromSchedule("daily", "9", "0", [0, 1, 2, 3, 4, 5, 6]),
    ).toBe("0 9 * * *");
  });

  it("sorts and joins a weekday subset", () => {
    expect(buildCronFromSchedule("daily", "9", "0", [5, 1, 3])).toBe(
      "0 9 * * 1,3,5",
    );
  });
});

describe("isValidCronExpression", () => {
  it.each([
    "0 9 * * 1-5",
    "*/15 * * * *",
    "0 0 1 * *",
  ])("accepts the valid expression %s", (expression) => {
    expect(isValidCronExpression(expression)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "not a cron",
    "0 9 * *",
    "99 99 * * *",
  ])("rejects the invalid expression %j", (expression) => {
    expect(isValidCronExpression(expression)).toBe(false);
  });
});

describe("buildScheduleTriggerPayload", () => {
  const validForm = () => ({
    ...DEFAULT_FORM_STATE(),
    name: "Daily summary",
    agentId: "agent-1",
    messageTemplate: "Do the thing",
  });

  it("returns a trimmed payload when all fields are valid", () => {
    const payload = buildScheduleTriggerPayload({
      ...validForm(),
      name: "  Daily summary  ",
      cronExpression: "  0 9 * * 1-5  ",
    });
    expect(payload).toMatchObject({
      name: "Daily summary",
      cronExpression: "0 9 * * 1-5",
    });
  });

  it("returns null when the cron expression is invalid", () => {
    expect(
      buildScheduleTriggerPayload({
        ...validForm(),
        cronExpression: "not a cron",
      }),
    ).toBeNull();
  });

  it("returns null when a required field is missing", () => {
    expect(
      buildScheduleTriggerPayload({ ...validForm(), messageTemplate: "" }),
    ).toBeNull();
  });
});
