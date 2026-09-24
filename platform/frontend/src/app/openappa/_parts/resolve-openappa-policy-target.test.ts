import { describe, expect, test } from "vitest";
import { resolveOpenAppaPolicyTarget } from "./resolve-openappa-policy-target";

const targetId = "e8340e76-19fc-444d-ac4e-a817c1e78c3c";

describe("resolveOpenAppaPolicyTarget", () => {
  test("resolves a valid target type and ID", () => {
    expect(
      resolveOpenAppaPolicyTarget({
        targetType: "mcp_server",
        targetId,
      }),
    ).toEqual({ kind: "mcp_server", id: targetId });
  });

  test("returns undefined when the target type is missing", () => {
    expect(resolveOpenAppaPolicyTarget({ targetId })).toBeUndefined();
  });

  test("returns undefined when the target ID is missing or invalid", () => {
    expect(
      resolveOpenAppaPolicyTarget({
        targetType: "mcp_server",
      }),
    ).toBeUndefined();
    expect(
      resolveOpenAppaPolicyTarget({
        targetType: "mcp_server",
        targetId: "not-an-id",
      }),
    ).toBeUndefined();
  });

  test("returns undefined for an unrecognized target type", () => {
    expect(
      resolveOpenAppaPolicyTarget({
        targetType: "bogus",
        targetId,
      }),
    ).toBeUndefined();
  });

  test("returns undefined when both params are absent", () => {
    expect(resolveOpenAppaPolicyTarget({})).toBeUndefined();
  });
});
