import { describe, expect, it } from "vitest";
import { validateCronMinimumInterval } from "./utils";

describe("validateCronMinimumInterval", () => {
  const timezone = "UTC";

  it("accepts an hourly schedule", () => {
    expect(() =>
      validateCronMinimumInterval({ cronExpression: "0 * * * *", timezone }),
    ).not.toThrow();
  });

  it("accepts a daily schedule", () => {
    expect(() =>
      validateCronMinimumInterval({ cronExpression: "0 0 * * *", timezone }),
    ).not.toThrow();
  });

  it("accepts a weekday schedule", () => {
    expect(() =>
      validateCronMinimumInterval({ cronExpression: "0 9 * * 1-5", timezone }),
    ).not.toThrow();
  });

  it("rejects an every-minute schedule", () => {
    expect(() =>
      validateCronMinimumInterval({ cronExpression: "* * * * *", timezone }),
    ).toThrow("Schedule must not fire more frequently than once per hour");
  });

  it("rejects an every-5-minutes schedule", () => {
    expect(() =>
      validateCronMinimumInterval({ cronExpression: "*/5 * * * *", timezone }),
    ).toThrow("Schedule must not fire more frequently than once per hour");
  });

  it("rejects an every-30-minutes schedule", () => {
    expect(() =>
      validateCronMinimumInterval({ cronExpression: "*/30 * * * *", timezone }),
    ).toThrow("Schedule must not fire more frequently than once per hour");
  });

  it("rejects multiple specific minutes in an hour if gap is < 1 hour", () => {
    expect(() =>
      validateCronMinimumInterval({ cronExpression: "0,30 * * * *", timezone }),
    ).toThrow("Schedule must not fire more frequently than once per hour");
  });
});
