import { describe, expect, it } from "vitest";
import { extractMcpServerName } from "./tool-error-logs-button.utils";

describe("extractMcpServerName", () => {
  it("should extract server name from a valid tool name", () => {
    expect(extractMcpServerName("myserver__mytool")).toBe("myserver");
  });

  it("should extract server name with underscores in server name", () => {
    expect(extractMcpServerName("my_server__mytool")).toBe("my_server");
  });

  it("should extract server name with multiple underscores in tool name", () => {
    expect(extractMcpServerName("server__my_tool_name")).toBe("server");
  });

  it("should return null for tool name without separator", () => {
    expect(extractMcpServerName("mytool")).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(extractMcpServerName("")).toBeNull();
  });

  it("should return empty string if separator is at the start", () => {
    expect(extractMcpServerName("__mytool")).toBe("");
  });

  it("should handle tool names with separator at the end", () => {
    expect(extractMcpServerName("server__")).toBe("server");
  });

  it("should handle multiple separators by using the first one", () => {
    expect(extractMcpServerName("server__tool__extra")).toBe("server");
  });
});
