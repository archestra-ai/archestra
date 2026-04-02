import { describe, expect, test } from "vitest";
import {
  MCP_APPS_CLIENT_EXTENSION_CAPABILITIES,
  MCP_APPS_EXTENSION_ID,
  MCP_APPS_SERVER_EXTENSION_CAPABILITIES,
  MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES,
  MCP_ENTERPRISE_AUTH_EXTENSION_ID,
} from "./mcp-extensions";

describe("MCP extension capabilities", () => {
  test("declares MCP Apps client capabilities with mcp-app mime type", () => {
    expect(MCP_APPS_CLIENT_EXTENSION_CAPABILITIES).toEqual({
      [MCP_APPS_EXTENSION_ID]: {
        mimeTypes: ["text/html;profile=mcp-app"],
      },
    });
  });

  test("declares MCP Apps server support", () => {
    expect(MCP_APPS_SERVER_EXTENSION_CAPABILITIES).toEqual({
      [MCP_APPS_EXTENSION_ID]: {},
    });
  });

  test("declares enterprise auth support", () => {
    expect(MCP_ENTERPRISE_AUTH_EXTENSION_CAPABILITIES).toEqual({
      [MCP_ENTERPRISE_AUTH_EXTENSION_ID]: {},
    });
  });
});
