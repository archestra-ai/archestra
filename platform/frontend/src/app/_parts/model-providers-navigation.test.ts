// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getModelProvidersNavigationUrl } from "./model-providers-navigation";

describe("getModelProvidersNavigationUrl", () => {
  it("opens Models when that is the only permitted tab", () => {
    expect(
      getModelProvidersNavigationUrl({
        "/llm/model-providers": false,
        "/llm/models": true,
      }),
    ).toBe("/llm/models");
  });

  it.each([
    { "/llm/model-providers": true, "/llm/models": false },
    { "/llm/model-providers": true, "/llm/models": true },
    undefined,
  ])("opens Subscriptions & API Keys when it is available or permissions are loading", (permissions) => {
    expect(getModelProvidersNavigationUrl(permissions)).toBe(
      "/llm/model-providers",
    );
  });
});
