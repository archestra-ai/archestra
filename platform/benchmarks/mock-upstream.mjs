import { once } from "node:events";
import http from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const MOCK_CONTENT = "archestra-benchmark-ok";

export function createMockServer({ chunks = 20, intervalMs = 10 } = {}) {
  return http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ benchmarkMock: 1, chunks, intervalMs }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    try {
      const parts = [];
      let size = 0;
      for await (const part of req) {
        size += part.length;
        if (size > 2 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        parts.push(part);
      }
      const request = JSON.parse(Buffer.concat(parts).toString());
      const base = {
        id: "chatcmpl-benchmark",
        created: 0,
        model: request.model,
      };
      // Synthetic usage; this fixture never calls an inference provider.
      const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      if (!request.stream) {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            ...base,
            object: "chat.completion",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: MOCK_CONTENT },
                finish_reason: "stop",
              },
            ],
            usage,
          }),
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const abort = new AbortController();
      res.once("close", () => abort.abort());
      const write = async (event) => {
        if (res.destroyed) throw new Error("Client disconnected");
        if (!res.write(`data: ${JSON.stringify(event)}\n\n`)) {
          await once(res, "drain", { signal: abort.signal });
        }
      };
      for (let i = 0; i < chunks; i++) {
        if (intervalMs)
          await sleep(intervalMs, undefined, { signal: abort.signal });
        await write({
          ...base,
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: { content: i === 0 ? MOCK_CONTENT : "." },
              finish_reason: null,
            },
          ],
        });
      }
      await write({
        ...base,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
      await write({
        ...base,
        object: "chat.completion.chunk",
        choices: [],
        usage,
      });
      res.end("data: [DONE]\n\n");
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else res.writeHead(400).end(JSON.stringify({ error: error.message }));
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const server = createMockServer();
  server.listen(19092, "127.0.0.1", () =>
    console.info("Benchmark mock: http://127.0.0.1:19092"),
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => server.close());
}
