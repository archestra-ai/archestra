import { describe, expect, test } from "vitest";
import { deviceMcpChildEnvironment } from "./child-environment";

describe("device MCP child environment", () => {
  test("adds only the Windows directory and never application credentials", () => {
    expect(
      deviceMcpChildEnvironment("win32", {
        WINDIR: "C:\\Windows",
        SYSTEMROOT: "C:\\Ignored",
        ARCHESTRA_AUTH_SECRET: "must-not-be-inherited",
        CONTROL_PLANE_API_KEY: "must-not-be-inherited",
      }),
    ).toEqual({ WINDIR: "C:\\Windows" });
  });

  test("uses OS directory aliases when WINDIR is unavailable", () => {
    expect(
      deviceMcpChildEnvironment("win32", { SystemRoot: "C:\\Windows" }),
    ).toEqual({ WINDIR: "C:\\Windows" });
    expect(
      deviceMcpChildEnvironment("win32", { SYSTEMROOT: "C:\\Windows" }),
    ).toEqual({ WINDIR: "C:\\Windows" });
    expect(deviceMcpChildEnvironment("win32", {})).toEqual({});
  });

  test("does not add Windows or application variables on macOS", () => {
    expect(
      deviceMcpChildEnvironment("darwin", {
        WINDIR: "C:\\Windows",
        ARCHESTRA_AUTH_SECRET: "must-not-be-inherited",
      }),
    ).toEqual({});
  });
});
