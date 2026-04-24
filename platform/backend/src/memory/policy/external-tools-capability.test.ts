import { describe, expect, test } from "vitest";
import {
  assessExternalToolCapabilities,
  attachExternalToolSecurityMetadata,
  buildExternalToolSecurityMetadata,
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

  test("detects browser/search/api capabilities from fallback tool names", () => {
    const capabilities = getExternalToolCapabilities([
      "playwright__browser_navigate",
      "duckduckgo__search",
      "remote__api_request",
    ]);

    expect(capabilities.has("browser")).toBe(true);
    expect(capabilities.has("search")).toBe(true);
    expect(capabilities.has("api")).toBe(true);
  });

  test("prefers attached metadata over tool-name heuristics", () => {
    const assessment = assessExternalToolCapabilities([
      [
        "remote__summarize",
        attachExternalToolSecurityMetadata(
          { description: "Summarizes remote content" },
          {
            capabilities: ["browser"],
            source: "metadata",
          },
        ),
      ],
    ]);

    expect(assessment.capabilities.has("browser")).toBe(true);
    expect(assessment.usedMetadata).toBe(true);
    expect(assessment.usedFallback).toBe(false);
  });

  test("marks fallback usage and unknown capabilities for tools without metadata", () => {
    const assessment = assessExternalToolCapabilities([
      [
        "custom__opaque_tool",
        { description: "No explicit capability metadata" },
      ],
    ]);

    expect(assessment.usedFallback).toBe(true);
    expect(assessment.fallbackToolNames).toEqual(["custom__opaque_tool"]);
    expect(assessment.unknownCapabilityToolNames).toEqual([
      "custom__opaque_tool",
    ]);
  });

  test("extracts explicit capability metadata from MCP tool definitions", () => {
    const metadata = buildExternalToolSecurityMetadata({
      toolName: "remote__summarize",
      toolDefinition: {
        _meta: {
          archestra: {
            capabilities: ["network", "browser"],
          },
        },
      },
    });

    expect(metadata).toEqual({
      capabilities: ["api", "browser"],
      source: "metadata",
    });
  });
});
