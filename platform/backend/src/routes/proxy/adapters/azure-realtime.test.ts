import { once } from "node:events";
import { afterEach, describe, expect, test } from "vitest";
import { type WebSocket, WebSocketServer } from "ws";
import { realtimePcmToWav } from "@/clients/realtime-audio";
import { azureRealtimeAdapterFactory } from "./azure-realtime";

let server: WebSocketServer | undefined;
afterEach(async () => {
  for (const socket of server?.clients ?? []) socket.terminate();
  if (server)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  server = undefined;
});

async function upstream(
  onConnection: (
    socket: WebSocket,
    url: string,
    key: string | undefined,
  ) => void,
) {
  server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  server.on("connection", (socket, request) =>
    onConnection(
      socket,
      request.url ?? "",
      request.headers["api-key"] as string | undefined,
    ),
  );
  await once(server, "listening");
  const address = server.address();
  if (typeof address !== "object" || !address)
    throw new Error("Missing test server address");
  return `http://127.0.0.1:${address.port}/openai/v1`;
}

describe("Azure native realtime media turns", () => {
  test("uses the realtime protocol and returns WAV speech with usage", async () => {
    const events: Record<string, unknown>[] = [];
    const baseUrl = await upstream((socket, url, key) => {
      expect(url).toBe("/openai/v1/realtime?model=gpt-realtime-2.1");
      expect(key).toBe("azure-test-key");
      socket.send(JSON.stringify({ type: "session.created" }));
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        events.push(event);
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
                usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
              },
            }),
          );
        }
      });
    });
    const client = azureRealtimeAdapterFactory.createClient("azure-test-key", {
      baseUrl,
      source: "api",
    });
    const response = await azureRealtimeAdapterFactory.execute(client, {
      model: "gpt-realtime-2.1",
      messages: [{ role: "user", content: "Hello." }],
    });
    expect(response.choices[0].message.content).toBe("Hello.");
    expect(
      Buffer.from(response.choices[0].message.audio.data, "base64").toString(
        "ascii",
        0,
        4,
      ),
    ).toBe("RIFF");
    expect(response.usage).toMatchObject({
      prompt_tokens: 3,
      completion_tokens: 4,
    });
    expect(events).toContainEqual({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Hello." }],
      },
    });
  });

  test("uses the dedicated translation protocol, configures a language, and flushes before closing", async () => {
    const events: Record<string, unknown>[] = [];
    const baseUrl = await upstream((socket, url) => {
      expect(url).toBe(
        "/openai/v1/realtime/translations?model=gpt-realtime-translate",
      );
      socket.send(JSON.stringify({ type: "session.created" }));
      socket.on("message", (raw) => {
        const event = JSON.parse(raw.toString());
        events.push(event);
        if (event.type === "session.update")
          socket.send(JSON.stringify({ type: "session.updated" }));
        if (event.type === "session.close") {
          socket.send(
            JSON.stringify({
              type: "session.output_audio.delta",
              delta: Buffer.alloc(48).toString("base64"),
            }),
          );
          socket.send(
            JSON.stringify({
              type: "session.output_transcript.delta",
              delta: "Hola.",
            }),
          );
          socket.send(JSON.stringify({ type: "session.closed" }));
        }
      });
    });
    const client = azureRealtimeAdapterFactory.createClient("azure-test-key", {
      baseUrl,
      source: "api",
    });
    const response = await azureRealtimeAdapterFactory.execute(client, {
      model: "gpt-realtime-translate",
      target_language: "es",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: realtimePcmToWav(Buffer.alloc(9600)).toString("base64"),
                format: "wav",
              },
            },
          ],
        },
      ],
    });
    expect(response.choices[0].message.content).toBe("Hola.");
    expect(events[0]).toEqual({
      type: "session.update",
      session: { audio: { output: { language: "es" } } },
    });
    expect(
      events.filter(
        (event) => event.type === "session.input_audio_buffer.append",
      ),
    ).toHaveLength(2);
    expect(events.at(-1)?.type).toBe("session.close");
    expect(events.some((event) => event.type === "response.create")).toBe(
      false,
    );
  });

  test("cancels the native connection when the caller aborts", async () => {
    let connected: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const baseUrl = await upstream(() => connected?.());
    const controller = new AbortController();
    const client = azureRealtimeAdapterFactory.createClient("azure-test-key", {
      baseUrl,
      source: "api",
      abortSignal: controller.signal,
    });
    const promise = azureRealtimeAdapterFactory.execute(client, {
      model: "gpt-realtime-2.1",
      messages: [{ role: "user", content: "Hello." }],
    });
    await ready;
    controller.abort(new Error("caller cancelled"));
    await expect(promise).rejects.toThrow("caller cancelled");
  });
});
