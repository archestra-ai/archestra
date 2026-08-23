import { describe, expect, it } from "vitest";
import { getCostsNavigationUrl } from "./costs-navigation";

describe("getCostsNavigationUrl", () => {
  it("opens Limits when that is the only permitted organization view", () => {
    expect(
      getCostsNavigationUrl({
        "/llm/costs": false,
        "/llm/limits": true,
      }),
    ).toBe("/llm/limits");
  });

  it.each([
    { "/llm/costs": true, "/llm/limits": false },
    { "/llm/costs": true, "/llm/limits": true },
    undefined,
  ])("opens Costs when it is available or permissions are loading", (permissions) => {
    expect(getCostsNavigationUrl(permissions)).toBe("/llm/costs");
  });
});
