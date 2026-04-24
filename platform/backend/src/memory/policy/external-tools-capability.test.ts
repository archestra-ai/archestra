import { describe, expect, test } from "vitest";
import {
  getExternalToolCapabilities,
  hasExternalCommunicationCapability,
} from "./external-tools-capability";

describe("external-tools-capability", () => {
  test("ignores built-in Archestra tools", () => {
    expect(
      hasExternalCommunicationCapability([
        "archestra__propose_memory_candidate",
      ]),
    ).toBe(false);
  });

  test("detects browser/search/api capabilities from external tools", () => {
    const capabilities = getExternalToolCapabilities([
      "playwright__browser_navigate",
      "duckduckgo__search",
      "remote__api_request",
    ]);

    expect(capabilities.has("browser")).toBe(true);
    expect(capabilities.has("search")).toBe(true);
    expect(capabilities.has("api")).toBe(true);
  });
});
