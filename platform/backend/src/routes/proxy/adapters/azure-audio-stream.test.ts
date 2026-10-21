import { once } from "node:events";
import { HttpResponse, http, passthrough } from "msw";
import { describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { realtimePcmToWav } from "@/clients/realtime-audio";
import { useMswServer } from "@/test/msw";
import type { Azure } from "@/types";
import { azureAdapterFactory } from "./azure";
import { azureRealtimeAdapterFactory } from "./azure-realtime";

// biome-ignore lint/correctness/useHookAtTopLevel: MSW helper registers test lifecycle hooks.
const server = useMswServer();

describe("Azure audio streaming", () => {
  test("exposes a nonstreaming speech transcript to response policies", () => {
    const response = {
      id: "turn-1",
      object: "chat.completion" as const,
      created: 1,
      model: "gpt-audio",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          logprobs: null,
          message: {
            role: "assistant" as const,
            content: null,
            audio: { id: "audio-1", data: "AQI=", transcript: "Hello." },
          },
        },
      ],
    };
    const adapter = azureAdapterFactory.createResponseAdapter(response);
    expect(adapter.getText()).toBe("Hello.");
    expect(
      adapter.toRefusalResponse("Blocked", "Blocked").choices[0].message.audio,
    ).toBeUndefined();
  });
  test("forwards native audio-only deltas and reconstructs bytes, transcript and usage", async () => {
    const first = Buffer.from([1, 2]);
    const second = Buffer.from([3, 4]);
    server.use(
      http.post(
        "https://azure.example/openai/v1/chat/completions",
        async ({ request }) => {
          expect(await request.json()).toMatchObject({
            model: "gpt-audio",
            stream: true,
            modalities: ["text", "audio"],
            audio: { voice: "alloy", format: "pcm16" },
          });
          return new HttpResponse(
            [
              chunk({ role: "assistant" }),
              chunk({
                audio: {
                  id: "audio-1",
                  data: first.toString("base64"),
                  transcript: "Hel",
                },
              }),
              chunk({
                audio: {
                  data: second.toString("base64"),
                  transcript: "lo",
                  expires_at: 123,
                },
              }),
              `data: ${JSON.stringify({ id: "turn-1", object: "chat.completion.chunk", created: 1, model: "gpt-audio", choices: [], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })}\n\n`,
              "data: [DONE]\n\n",
            ].join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      ),
    );
    const client = azureAdapterFactory.createClient("test-key", {
      baseUrl: "https://azure.example/openai/v1",
      source: "api",
    });
    const stream = await azureAdapterFactory.executeStream(client, {
      model: "gpt-audio",
      messages: [{ role: "user", content: "Say hello." }],
      modalities: ["text", "audio"],
      audio: { voice: "alloy", format: "pcm16" },
    });
    const adapter = azureAdapterFactory.createStreamAdapter();
    const frames: string[] = [];
    for await (const event of stream) {
      const result = adapter.processChunk(event);
      if (result.sseData) frames.push(String(result.sseData));
    }
    expect(frames.join("")).toContain(first.toString("base64"));
    expect(frames.join("")).toContain(second.toString("base64"));
    expect(adapter.state.text).toBe("Hello");
    expect(adapter.toProviderResponse()).toMatchObject({
      choices: [
        {
          message: {
            audio: {
              id: "audio-1",
              data: Buffer.concat([first, second]).toString("base64"),
              transcript: "Hello",
              expires_at: 123,
            },
          },
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    });
  });

  test("preserves a completed native realtime WAV turn in SSE and persisted response", async () => {
    const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    upstream.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "session.created" }));
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        if (event.type === "session.update")
          socket.send(JSON.stringify({ type: "session.updated" }));
        if (event.type === "response.create") {
          socket.send(
            JSON.stringify({
              type: "response.output_audio.delta",
              delta: Buffer.alloc(48).toString("base64"),
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.output_audio_transcript.delta",
              delta: "Hello.",
            }),
          );
          socket.send(
            JSON.stringify({
              type: "response.done",
              response: {
                status: "completed",
                usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
              },
            }),
          );
        }
      });
    });
    await once(upstream, "listening");
    try {
      const address = upstream.address();
      if (!address || typeof address === "string")
        throw new Error("No test server address");
      server.use(
        http.get(`http://127.0.0.1:${address.port}/openai/v1/realtime`, () =>
          passthrough(),
        ),
      );
      const client = azureRealtimeAdapterFactory.createClient("test-key", {
        baseUrl: `http://127.0.0.1:${address.port}/openai/v1`,
        source: "api",
      });
      const stream = await azureRealtimeAdapterFactory.executeStream(client, {
        model: "gpt-realtime-2.1",
        messages: [{ role: "user", content: "Say hello." }],
      });
      const adapter = azureRealtimeAdapterFactory.createStreamAdapter();
      const frames: string[] = [];
      for await (const event of stream) {
        const result = adapter.processChunk(event);
        if (result.sseData) {
          expect(result.isResponsePreamble).toBe(false);
          frames.push(String(result.sseData));
        }
      }
      const wav = realtimePcmToWav(Buffer.alloc(48)).toString("base64");
      expect(frames.join("")).toContain(wav);
      expect(
        adapter.toProviderResponse().choices[0].message.audio,
      ).toMatchObject({ data: wav, transcript: "Hello." });
      expect(adapter.state.text).toBe("Hello.");
    } finally {
      for (const socket of upstream.clients) socket.terminate();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });

  test("does not treat role-plus-audio as a safe preamble and clears withheld media on policy replacement", () => {
    const adapter = azureAdapterFactory.createStreamAdapter();
    const result = adapter.processChunk(
      JSON.parse(
        chunk({
          role: "assistant",
          audio: { data: "AQI=", transcript: "Withheld" },
        }).slice(6),
      ) as Azure.Types.ChatCompletionChunk,
    );
    expect(result.isResponsePreamble).toBe(false);
    adapter.prepareResponseReplacement?.();
    adapter.formatCompleteTextSSE("Blocked by policy");
    expect(adapter.toProviderResponse().choices[0].message).toMatchObject({
      content: "Blocked by policy",
    });
    expect(
      adapter.toProviderResponse().choices[0].message.audio,
    ).toBeUndefined();
  });
});

function chunk(delta: Record<string, unknown>) {
  return `data: ${JSON.stringify({ id: "turn-1", object: "chat.completion.chunk", created: 1, model: "gpt-audio", choices: [{ index: 0, finish_reason: null, delta }] })}\n\n`;
}
