import { describe, expect, test } from "vitest";
import { parseFullToolName } from "./utils";

describe("parseFullToolName", () => {
  test("standard case: server__tool", () => {
    expect(parseFullToolName("outlook-abc__send_email")).toEqual({
      serverName: "outlook-abc",
      toolName: "send_email",
    });
  });

  test("tool name with __ preserved", () => {
    expect(parseFullToolName("server__tool__extra")).toEqual({
      serverName: "server",
      toolName: "tool__extra",
    });
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
});
