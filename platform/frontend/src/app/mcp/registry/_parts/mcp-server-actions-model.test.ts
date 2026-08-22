import { describe, expect, it } from "vitest";
import {
  getMcpServerActionModel,
  mcpServerAction,
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
      placement: "primary",
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
