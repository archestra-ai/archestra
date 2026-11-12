import { describe, expect, test } from "vitest";
import {
  DESKTOP_MCP_ARGUMENTS_MIN_PROGRAM_VERSION,
  programAppliesDesktopMcpArguments,
} from "./desktop-mcp";

describe("programAppliesDesktopMcpArguments", () => {
  test("the first version with arguments, and each one after it, applies them", () => {
    expect(
      programAppliesDesktopMcpArguments(
        DESKTOP_MCP_ARGUMENTS_MIN_PROGRAM_VERSION,
      ),
    ).toBe(true);
    for (const version of ["0.1.2", "0.1.3", "0.1.10", "0.2.0", "1.0.0"]) {
      expect(programAppliesDesktopMcpArguments(version), version).toBe(true);
    }
  });

  test("a version before it does not", () => {
    for (const version of ["0.1.0", "0.1.1", "0.0.9", "0.1"]) {
      expect(programAppliesDesktopMcpArguments(version), version).toBe(false);
    }
  });

  test("the numbers are compared as numbers, not as text", () => {
    expect(programAppliesDesktopMcpArguments("0.1.10")).toBe(true);
    expect(programAppliesDesktopMcpArguments("0.10.0")).toBe(true);
    expect(programAppliesDesktopMcpArguments("0.01.1")).toBe(false);
  });

  test("a part that is missing counts as 0", () => {
    expect(programAppliesDesktopMcpArguments("0.2")).toBe(true);
    expect(programAppliesDesktopMcpArguments("1")).toBe(true);
    expect(programAppliesDesktopMcpArguments("0.1.2.0")).toBe(true);
  });

  test("what comes after - or + is not compared", () => {
    expect(programAppliesDesktopMcpArguments("0.1.2-dev")).toBe(true);
    expect(programAppliesDesktopMcpArguments("0.1.2+build.7")).toBe(true);
    expect(programAppliesDesktopMcpArguments("v0.1.2")).toBe(true);
    expect(programAppliesDesktopMcpArguments(" 0.1.2 ")).toBe(true);
    expect(programAppliesDesktopMcpArguments("0.1.1-dev")).toBe(false);
  });

  test("a device with no version, or with a text that is not a version, does not", () => {
    for (const version of [
      null,
      undefined,
      "",
      "  ",
      "dev",
      "latest",
      "0.1.x",
      "0..2",
      ".1.2",
      "0.1.2.",
      "0.1.2rc1",
      "-1.0.0",
      "1.0.0.0.0",
    ]) {
      expect(programAppliesDesktopMcpArguments(version), String(version)).toBe(
        false,
      );
    }
  });
});
