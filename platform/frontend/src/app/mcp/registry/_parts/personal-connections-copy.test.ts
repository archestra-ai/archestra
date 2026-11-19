// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DESKTOP_MCP_NO_TARGET_REASON } from "./desktop-mcp-install";
import { personalConnectionsCopy } from "./personal-connections-copy";

const base = {
  multitenant: false,
  isMemberView: false,
  desktopNotSetUp: false,
};

describe("personalConnectionsCopy", () => {
  it("speaks of computers for a desktop MCP server", () => {
    expect(
      personalConnectionsCopy({ ...base, serverType: "desktop_mcp" }),
    ).toMatchObject({
      noun: "device",
      add: "Connect",
      emptyText: "No one has connected it from their device yet.",
    });
  });

  it("says why nothing can be added for a desktop MCP item with no command and no URL", () => {
    expect(
      personalConnectionsCopy({
        ...base,
        serverType: "desktop_mcp",
        desktopNotSetUp: true,
      }).emptyText,
    ).toBe(DESKTOP_MCP_NO_TARGET_REASON);
  });

  it('drops "for me" where a member sees only their own installation', () => {
    const add = (isMemberView: boolean) =>
      personalConnectionsCopy({ ...base, serverType: "local", isMemberView })
        .add;
    expect(add(false)).toBe("Install for me");
    expect(add(true)).toBe("Install");
  });

  it("describes access to the shared deployment of a multi-tenant server", () => {
    const description = (multitenant: boolean) =>
      personalConnectionsCopy({ ...base, serverType: "local", multitenant })
        .description;
    expect(description(true)).not.toBe(description(false));
  });

  it("speaks of connections for a remote server, and until the item loads", () => {
    for (const serverType of ["remote", undefined] as const) {
      expect(personalConnectionsCopy({ ...base, serverType })).toMatchObject({
        noun: "credential",
        title: "Personal connections",
        add: "Connect my account",
      });
    }
  });
});
