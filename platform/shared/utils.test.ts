import { describe, expect, test } from "vitest";
import {
  getArchestraToolShortName,
  isArchestraMcpServerTool,
  parseFullToolName,
} from "./utils";

describe("parseFullToolName", () => {
  test("standard case: server__tool", () => {
    expect(parseFullToolName("outlook-abc__send_email")).toEqual({
      serverName: "outlook-abc",
      toolName: "send_email",
    });
  });

  test("server name containing __ (e.g., upstash__context7)", () => {
    expect(parseFullToolName("upstash__context7__resolve-library-id")).toEqual({
      serverName: "upstash__context7",
      toolName: "resolve-library-id",
    });
  });

  test("server name with multiple __ segments", () => {
    expect(parseFullToolName("huggingface__remote-mcp__generate_text")).toEqual(
      {
        serverName: "huggingface__remote-mcp",
        toolName: "generate_text",
      },
    );
  });

  test("no separator returns null serverName", () => {
    expect(parseFullToolName("send_email")).toEqual({
      serverName: null,
      toolName: "send_email",
    });
  });

  test("empty string after separator", () => {
    expect(parseFullToolName("server__")).toEqual({
      serverName: "server",
      toolName: "",
    });
  });

  test("archestra tools", () => {
    expect(parseFullToolName("archestra__whoami")).toEqual({
      serverName: "archestra",
      toolName: "whoami",
    });
  });

  test("separator at start returns null serverName", () => {
    expect(parseFullToolName("__toolname")).toEqual({
      serverName: null,
      toolName: "__toolname",
    });
  });

  test("empty string", () => {
    expect(parseFullToolName("")).toEqual({
      serverName: null,
      toolName: "",
    });
  });

  test("single underscore is not treated as separator", () => {
    expect(parseFullToolName("my_server__my_tool")).toEqual({
      serverName: "my_server",
      toolName: "my_tool",
    });
  });

  test("tool name with hyphens", () => {
    expect(parseFullToolName("github__create-pull-request")).toEqual({
      serverName: "github",
      toolName: "create-pull-request",
    });
  });
});

describe("isArchestraMcpServerTool", () => {
  test("returns true for Archestra tools", () => {
    expect(isArchestraMcpServerTool("archestra__whoami")).toBe(true);
  });

  test("returns false for non-Archestra tools", () => {
    expect(isArchestraMcpServerTool("github__list_issues")).toBe(false);
  });
});

describe("getArchestraToolShortName", () => {
  test("extracts the short name from an Archestra tool", () => {
    expect(getArchestraToolShortName("archestra__create_agent")).toBe(
      "create_agent",
    );
  });

  test("returns null for non-Archestra tools", () => {
    expect(getArchestraToolShortName("github__list_issues")).toBeNull();
  });
});
