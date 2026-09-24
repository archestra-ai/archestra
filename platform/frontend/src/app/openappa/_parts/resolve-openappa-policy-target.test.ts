import { describe, expect, test } from "vitest";
import { resolveOpenAppaPolicyTarget } from "./resolve-openappa-policy-target";

describe("resolveOpenAppaPolicyTarget", () => {
  test("resolves a valid target type and name", () => {
    expect(
      resolveOpenAppaPolicyTarget({
        targetType: "mcp_server",
        targetName: "GitHub",
      }),
    ).toEqual({ kind: "mcp_server", name: "GitHub" });
  });

  test("returns undefined when the target type is missing", () => {
    expect(
      resolveOpenAppaPolicyTarget({ targetName: "GitHub" }),
    ).toBeUndefined();
  });

  test("returns undefined when the target name is missing", () => {
    expect(
      resolveOpenAppaPolicyTarget({ targetType: "mcp_server" }),
    ).toBeUndefined();
  });

  test("returns undefined for an unrecognized target type", () => {
    expect(
      resolveOpenAppaPolicyTarget({
        targetType: "bogus",
        targetName: "GitHub",
      }),
    ).toBeUndefined();
  });

  test("returns undefined when both params are absent", () => {
    expect(resolveOpenAppaPolicyTarget({})).toBeUndefined();
  });
});
