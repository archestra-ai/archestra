import http from "node:http";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";

export function createStub() {
  const samples = [];
  const content = "archestra-benchmark-ok";
  return http.createServer(async (req, res) => {
    if (req.url === "/health") return res.end("ok");
    if (req.url === "/samples") {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify(samples));
    }
    if (req.url !== "/v1/chat/completions" || req.method !== "POST")
      return res.writeHead(404).end();
    const start = performance.now();
    const parts = [];
    for await (const part of req) parts.push(part);
    const body = JSON.parse(Buffer.concat(parts));
    const id = body.messages[0].content.split("Correlation: ").at(-1);
    const base = { id: `chatcmpl-${id}`, created: 1, model: body.model };
    const usage = {
      prompt_tokens: 12,
      completion_tokens: 20,
      total_tokens: 32,
    };
    let firstContentMs;
    let responseBytes = 0;
    const write = (text) => {
      responseBytes += Buffer.byteLength(text);
      res.write(text);
    };
    if (body.stream) {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      for (let i = 0; i < 20; i++) {
        await sleep(10);
        firstContentMs ??= performance.now() - start;
        write(
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: i ? "." : content }, finish_reason: null }] })}\n\n`,
        );
      }
      write(
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      write(
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage })}\n\n`,
      );
      write("data: [DONE]\n\n");
    } else {
      res.setHeader("content-type", "application/json");
      firstContentMs = performance.now() - start;
      write(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage,
        }),
      );
    }
    res.end();
    samples.push({
      id,
      user: body.user,
      model: body.model,
      stream: !!body.stream,
      requestBytes: Buffer.concat(parts).length,
      responseBytes,
      durationMs: performance.now() - start,
      firstContentMs,
      messages: body.messages,
      max_tokens: body.max_tokens,
      stream_options: body.stream_options ?? null,
      usage,
    });
  });
}
if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
)
  createStub().listen(19092, "127.0.0.1");
