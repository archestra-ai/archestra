// @vitest-environment node
import { describe, expect, it } from "vitest";
import { resolvePluginInstallSelection } from "./plugin-page-config";

describe("resolvePluginInstallSelection", () => {
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
