import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { CompletionReader } from "../measure.mjs";
import { createStub } from "./stub.mjs";

test("stub preserves correlation and token usage for complete JSON and SSE requests", async () => {
  const server = createStub().listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const stream of [false, true]) {
      const body = {
        user: "benchmark-user",
        model: "gpt-4o-mini",
        messages: [
          { role: "user", content: `marker Correlation: probe-${stream}` },
        ],
        max_tokens: 32,
        stream,
        ...(stream ? { stream_options: { include_usage: true } } : {}),
      };
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      if (!stream)
        assert.deepEqual(JSON.parse(text).usage, {
          prompt_tokens: 12,
          completion_tokens: 20,
          total_tokens: 32,
        });
      else {
        const reader = new CompletionReader({ streaming: true });
        // Test framing through arbitrary byte boundaries, not TCP chunks.
        for (const byte of Buffer.from(text)) reader.push(Buffer.from([byte]));
        assert.equal(
          reader.finish(),
          `archestra-benchmark-ok${".".repeat(19)}`,
        );
        assert.match(text, /"completion_tokens":20/);
      }
    }
    const samples = await fetch(`${base}/samples`).then((r) => r.json());
    assert.equal(samples.length, 2);
    assert.deepEqual(
      samples.map((s) => s.id),
      ["probe-false", "probe-true"],
    );
    assert.ok(samples[1].durationMs > samples[1].firstContentMs);
    assert.equal(samples[1].stream_options.include_usage, true);
    assert.equal(samples[1].max_tokens, 32);
    assert.ok(samples.every((s) => s.user === "benchmark-user"));
    assert.equal(samples[1].usage.total_tokens, 32);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
