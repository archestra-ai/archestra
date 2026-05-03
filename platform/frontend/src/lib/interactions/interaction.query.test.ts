import { describe, expect, test } from "vitest";
import { getInteractionRefetchInterval } from "./interaction.query";

describe("getInteractionRefetchInterval", () => {
  test("polls interaction details by default", () => {
    expect(getInteractionRefetchInterval()).toBe(3_000);
    expect(getInteractionRefetchInterval(10_000)).toBe(10_000);
  });

  test("stops polling when explicitly disabled", () => {
    expect(getInteractionRefetchInterval(null)).toBe(false);
  });
});
