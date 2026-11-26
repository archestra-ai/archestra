import http from "node:http";
import type { AddressInfo } from "node:net";
import { MCP_FILES_EXTENSION_ID } from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { parseFilesSupport, sendStatelessRequest } from "./stateless-upstream";

const discover = (settings: unknown, versions = ["2026-07-28"]) => ({
  supportedVersions: versions,
  capabilities: { extensions: { [MCP_FILES_EXTENSION_ID]: settings } },
});

describe("parseFilesSupport", () => {
  test("reads upload and the inline limit", () => {
    expect(
      parseFilesSupport(discover({ upload: {}, maxInlineBytes: 1024 })),
    ).toEqual({
      upload: true,
      maxInlineBytes: 1024,
    });
    expect(parseFilesSupport(discover({}))).toEqual({
      upload: false,
      maxInlineBytes: 0,
    });
  });

  test("an unknown revision, a missing extension or an older server means no support", () => {
    const none = { upload: false, maxInlineBytes: 0 };
    expect(parseFilesSupport(discover({ upload: {}, revision: "2" }))).toEqual(
      none,
    );
    expect(parseFilesSupport(discover(undefined))).toEqual(none);
    expect(parseFilesSupport(discover({ upload: {} }, ["2025-11-25"]))).toEqual(
      none,
    );
    expect(parseFilesSupport({})).toEqual(none);
  });
});

describe("sendStatelessRequest", () => {
  test("reads an SSE answer whose CRLF event delimiter is split across reads", async () => {
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const { id } = JSON.parse(Buffer.concat(chunks).toString());
      res.writeHead(200, { "content-type": "text/event-stream" });
      const event = `data: ${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\r\n\r`;
      res.write(event);
      setTimeout(() => res.end("\n"), 20);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const outcome = await sendStatelessRequest({
        target: {
          url: new URL(`http://127.0.0.1:${port}/mcp`),
          headers: {},
          credentialHeaders: {},
          fetch,
          signsRequests: false,
        },
        method: "tools/list",
        requestParams: {},
        clientCapabilities: {},
        signal: AbortSignal.timeout(5_000),
      });
      expect(outcome).toEqual({ kind: "result", result: { ok: true } });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
