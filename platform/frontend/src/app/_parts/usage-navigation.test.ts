import { describe, expect, it } from "vitest";
import { getUsageNavigationLabel } from "./usage-navigation";

describe("getUsageNavigationLabel", () => {
  it("names the personal-only destination My Usage", () => {
    expect(
      getUsageNavigationLabel({
        "/llm/costs": false,
        "/llm/limits": false,
      }),
    ).toBe("My Usage");
  });

  it.each([
    { "/llm/costs": true, "/llm/limits": false },
    { "/llm/costs": false, "/llm/limits": true },
    { "/llm/costs": true, "/llm/limits": true },
    undefined,
  ])("uses the umbrella label when another view is available", (permissions) => {
    expect(getUsageNavigationLabel(permissions)).toBe("Usage & Costs");
  });
});
