// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pluginRepository } from "./plugin-source-icon";

const source = {
  sourceMarketplaceRepo: "acme/plugins",
  sourceRepo: "acme/plugins",
};

describe("pluginRepository", () => {
  it("keeps the same path on github.com, gitlab.com, and Enterprise apart", () => {
    expect(pluginRepository({ ...source, sourceProvider: "github" })).toBe(
      "acme/plugins",
    );
    expect(pluginRepository({ ...source, sourceProvider: "gitlab" })).toBe(
      "https://gitlab.com/acme/plugins",
    );
    expect(
      pluginRepository({
        ...source,
        sourceProvider: "gitlab",
        sourceOrigin: "https://gitlab.example.com",
      }),
    ).toBe("https://gitlab.example.com/acme/plugins");
  });

  it("has no repository for a manual plugin", () => {
    expect(
      pluginRepository({ sourceMarketplaceRepo: null, sourceRepo: null }),
    ).toBeNull();
  });
});
