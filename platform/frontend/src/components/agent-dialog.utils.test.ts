import { describe, expect, it } from "vitest";
import {
  getDescriptionPlaceholder,
  getNamePlaceholder,
  shouldShowDescriptionField,
} from "./agent-dialog.utils";

describe("getNamePlaceholder", () => {
  it("returns type-specific placeholders", () => {
    expect(getNamePlaceholder("agent")).toBe("Enter agent name");
    expect(getNamePlaceholder("mcp_gateway")).toBe("Enter MCP Gateway name");
    expect(getNamePlaceholder("llm_proxy")).toBe("Enter LLM Proxy name");
    expect(getNamePlaceholder("profile")).toBe("Enter profile name");
  });
});

describe("getDescriptionPlaceholder", () => {
  it("returns type-specific description placeholders", () => {
    expect(getDescriptionPlaceholder("agent")).toBe(
      "Describe what this agent does",
    );
    expect(getDescriptionPlaceholder("mcp_gateway")).toBe(
      "Describe what this MCP Gateway is for",
    );
    expect(getDescriptionPlaceholder("llm_proxy")).toBe(
      "Describe what this LLM Proxy is for",
    );
    expect(getDescriptionPlaceholder("profile")).toBe(
      "Describe what this profile is for",
    );
  });
});

describe("shouldShowDescriptionField", () => {
  it("shows descriptions for non-built-in types", () => {
    expect(
      shouldShowDescriptionField({ agentType: "agent", isBuiltIn: false }),
    ).toBe(true);
    expect(
      shouldShowDescriptionField({
        agentType: "mcp_gateway",
        isBuiltIn: false,
      }),
    ).toBe(true);
    expect(
      shouldShowDescriptionField({ agentType: "llm_proxy", isBuiltIn: false }),
    ).toBe(true);
    expect(
      shouldShowDescriptionField({ agentType: "profile", isBuiltIn: false }),
    ).toBe(true);
  });

  it("hides descriptions for built-in types", () => {
    expect(
      shouldShowDescriptionField({ agentType: "agent", isBuiltIn: true }),
    ).toBe(false);
  });
});
