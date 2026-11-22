// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getCostControlsNavigationUrl } from "./costs-navigation";

describe("getCostControlsNavigationUrl", () => {
  it("opens Exports when that is the only permitted view", () => {
    expect(
      getCostControlsNavigationUrl({
        "/llm/limits": false,
        "/llm/cost-exports": true,
      }),
    ).toBe("/llm/cost-exports");
  });

  it.each([
    { "/llm/limits": true, "/llm/cost-exports": false },
    { "/llm/limits": true, "/llm/cost-exports": true },
    undefined,
  ])("opens Limits when it is available or permissions are loading", (permissions) => {
    expect(getCostControlsNavigationUrl(permissions)).toBe("/llm/limits");
  });
});
