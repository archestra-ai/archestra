import { createServer, type Server } from "node:http";
import { Agent } from "undici";
import config from "@/config";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { getLlmUpstreamDispatcher } from "./llm-upstream-dispatcher";

describe("getLlmUpstreamDispatcher", () => {
  test("returns an Agent when a timeout is configured, undefined otherwise", () => {
    const result = getLlmUpstreamDispatcher();
    if (config.llmProxy.upstreamTimeoutMs === undefined) {
      expect(result).toBeUndefined();
    } else {
      expect(result).toBeInstanceOf(Agent);
    }
  });
});

// Guards the core mechanism the fix relies on: a custom undici Agent with a
// raised headersTimeout, passed via the `dispatcher` option, actually governs
// global fetch's time-to-first-byte (and guards against the undici regression
// class where a configured headersTimeout fails to apply).
describe("undici Agent headersTimeout enforcement", () => {
  let server: Server;
  let url = "";
  let headerDelayMs: number | undefined = 0;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      if (headerDelayMs === undefined) {
        return;
      }

      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      }, headerDelayMs);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const addr = server.address();
    if (addr && typeof addr === "object") {
      url = `http://127.0.0.1:${addr.port}/`;
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("aborts with UND_ERR_HEADERS_TIMEOUT when headers arrive after the timeout", async () => {
    headerDelayMs = undefined;
    const dispatcher = new Agent({ headersTimeout: 150, bodyTimeout: 150 });
    try {
      await expect(
        globalThis.fetch(url, {
          dispatcher,
          signal: AbortSignal.timeout(5000),
        } as RequestInit),
      ).rejects.toMatchObject({ cause: { code: "UND_ERR_HEADERS_TIMEOUT" } });
    } finally {
      await dispatcher.close();
    }
  });

  test("completes when the timeout is generous enough", async () => {
    headerDelayMs = 100;
    const dispatcher = new Agent({ headersTimeout: 5000, bodyTimeout: 5000 });
    try {
      const res = await globalThis.fetch(url, { dispatcher } as RequestInit);
      expect(res.status).toBe(200);
      await res.text();
    } finally {
      await dispatcher.close();
    }
  });
});
