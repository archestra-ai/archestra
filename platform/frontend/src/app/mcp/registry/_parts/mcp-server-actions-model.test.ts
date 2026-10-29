// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  getMcpServerActionModel,
  mcpServerAction,
  mcpServerLogsHref,
} from "./mcp-server-actions-model";

describe("getMcpServerActionModel", () => {
  it.each([
    ["local", "Installations"],
    ["remote", "Credentials"],
  ] as const)("shares the %s connection action with both surfaces", (serverType, label) => {
    const action = mcpServerAction(
      getMcpServerActionModel({ id: "server-1", serverType }),
      "connections",
    );

    expect(action).toMatchObject({
      label,
      href: "/mcp/registry/server-1?tab=credentials",
    });
  });

  it("omits a connections destination for the built-in server", () => {
    const action = mcpServerAction(
      getMcpServerActionModel({ id: "builtin", serverType: "builtin" }),
      "connections",
    );
    expect(action.href).toBeUndefined();
  });
});

describe("mcpServerLogsHref", () => {
  it("opens the server page's Logs tab on the given installation for a local server", () => {
    expect(
      mcpServerLogsHref({
        item: { id: "server-1", serverType: "local" },
        serverId: "install-1",
      }),
    ).toBe("/mcp/registry/server-1?tab=logs&server=install-1");
  });

  it.each([
    "remote",
    "builtin",
  ] as const)("has no destination for a %s server, whose page has no Logs tab", (serverType) => {
    expect(
      mcpServerLogsHref({ item: { id: "server-1", serverType } }),
    ).toBeNull();
    expect(
      mcpServerAction(
        getMcpServerActionModel({ id: "server-1", serverType }),
        "logs",
      ).href,
    ).toBeUndefined();
  });
});
