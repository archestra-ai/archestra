import { describe, expect, it } from "vitest";
import {
  comparePinnedPluginTableOrder,
  comparePluginCatalogOrder,
  comparePluginRepositoryOrder,
  isArchestraPlugin,
  resolvePluginInstallSelection,
} from "./plugin-page-config";

const OPENAPPA = {
  displayName: "OpenAPPA",
  sourceMarketplaceRepo: "archestra-ai/OpenAPPA",
  sourceMarketplacePath: ".claude-plugin/marketplace.json",
  sourceMarketplacePluginName: "appa-runtime",
};

describe("Plugin catalog identity", () => {
  it("recognizes OpenAPPA by stable marketplace provenance", () => {
    expect(isArchestraPlugin(OPENAPPA)).toBe(true);
  });

  it("sorts the Archestra plugin before alphabetical community entries", () => {
    const plugins = [
      { displayName: "Alpha plugin" },
      OPENAPPA,
      { displayName: "Zulu plugin" },
    ];

    expect(
      plugins.sort(comparePluginCatalogOrder).map((item) => item.displayName),
    ).toEqual(["OpenAPPA", "Alpha plugin", "Zulu plugin"]);
  });

  it("keeps OpenAPPA pinned for ascending and descending table sorts", () => {
    const community = {
      displayName: "Zulu plugin",
      sourceMarketplaceRepo: null,
    };

    expect(
      comparePinnedPluginTableOrder({
        left: OPENAPPA,
        right: community,
        descending: false,
        fallbackResult: 1,
      }),
    ).toBeLessThan(0);
    expect(
      comparePinnedPluginTableOrder({
        left: OPENAPPA,
        right: community,
        descending: true,
        fallbackResult: -1,
      }),
    ).toBeGreaterThan(0);
  });

  it("pins the OpenAPPA repository before alphabetical repositories", () => {
    expect(
      ["zeta/repository", "archestra-ai/OpenAPPA", "alpha/repository"].sort(
        comparePluginRepositoryOrder,
      ),
    ).toEqual(["archestra-ai/OpenAPPA", "alpha/repository", "zeta/repository"]);
  });

  it("requires one client and a shared platform for bulk installation", () => {
    expect(
      resolvePluginInstallSelection([
        { clientType: "claude-code", supportedPlatforms: ["posix"] },
        { clientType: "codex", supportedPlatforms: ["posix"] },
      ]).error,
    ).toBe("Select plugins for one client at a time");
    expect(
      resolvePluginInstallSelection([
        { clientType: "claude-code", supportedPlatforms: ["posix"] },
        { clientType: "claude-code", supportedPlatforms: ["windows"] },
      ]).error,
    ).toBe("Selected plugins have no common platform");
  });
});
