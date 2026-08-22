import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { describe, expect, test, vi } from "vitest";
import { captureServerExtensions } from "./mcp-server-extensions";

describe("captureServerExtensions", () => {
  test("preserves extension capabilities before SDK parsing", () => {
    const transport = {} as Transport;
    const read = captureServerExtensions(transport);
    const downstream = vi.fn();
    transport.onmessage = downstream;

    transport.onmessage?.({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        capabilities: {
          extensions: {
            "io.modelcontextprotocol/skills": { directoryRead: true },
          },
        },
        serverInfo: { name: "test", version: "1" },
      },
    });

    expect(read()).toEqual({
      "io.modelcontextprotocol/skills": { directoryRead: true },
    });
    expect(downstream).toHaveBeenCalledOnce();
  });
});
