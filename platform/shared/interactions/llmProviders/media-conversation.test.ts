import { describe, expect, it } from "vitest";
import { DynamicInteraction } from "../interaction.utils";
import type { Interaction } from "./common";

/** The conversation the Logs page renders for a logged row. */
function conversation(row: {
  type: string;
  model: string;
  request: unknown;
  response: unknown;
}) {
  const interaction = new DynamicInteraction(row as unknown as Interaction);
  return {
    messages: interaction.mapToUiMessages(),
    title: interaction.getLastUserMessage(),
    reply: interaction.getLastAssistantResponse(),
  };
}

describe("media and embeddings in the conversation view", () => {
  it("shows what an embeddings call embedded, and its vectors to draw", () => {
    const floats = new Float32Array([0.5, -0.25, 0.125]);
    const base64 = Buffer.from(floats.buffer).toString("base64");
    const single = conversation({
      type: "openai:embeddings",
      model: "text-embedding-3-small",
      request: { model: "text-embedding-3-small", input: "hi" },
      response: { data: [{ embedding: [0.1, -0.2, 0.3] }] },
    });
    expect(single.title).toBe("hi");
    expect(single.reply).toBe("1 embedding, 3 dimensions");
    expect(single.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "data-embedding",
            data: {
              count: 1,
              dimensions: 3,
              vectors: [{ label: undefined, values: [0.1, -0.2, 0.3] }],
            },
          },
        ],
      },
    ]);

    // A batch labels each vector with its input; base64 vectors decode.
    const batch = conversation({
      type: "openai:embeddings",
      model: "text-embedding-3-small",
      request: { input: ["a", "b", "c", "d", "e", "f", "g"] },
      response: {
        data: Array.from({ length: 7 }, () => ({ embedding: base64 })),
      },
    });
    expect(batch.title).toBe("a (+6 more)");
    expect(batch.messages[0].parts).toEqual([
      { type: "text", text: "a\nb\nc\nd\ne\n+2 more inputs" },
    ]);
    const data = (
      batch.messages[1].parts[0] as {
        data: { count: number; dimensions: number; vectors: unknown[] };
      }
    ).data;
    expect(data).toMatchObject({ count: 7, dimensions: 3 });
    expect(data.vectors).toHaveLength(5);
    expect(data.vectors[0]).toEqual({
      label: "a",
      values: [0.5, -0.25, 0.125],
    });
  });

  it("shows an edit's uploads and mask beside the generated image", () => {
    const { messages, reply } = conversation({
      type: "openai:images",
      model: "gpt-image-1-mini",
      request: {
        prompt: "Make the circle red",
        input_files: {
          images: [
            {
              filename: "circle.png",
              mime_type: "image/png",
              width: 1024,
              height: 1024,
              data: "iVBORw0KGgo",
            },
            {
              filename: "photo.jpg",
              mime_type: "image/jpeg",
              width: 4032,
              height: 3024,
              data_omitted: "too_large",
            },
          ],
          mask: {
            filename: "mask.png",
            mime_type: "image/png",
            width: 1024,
            height: 1024,
            data: "iVBORw0KGgoM",
          },
        },
      },
      response: {
        data: [{ b64_json: "iVBORw0KGgo" }],
        size: "1024x1024",
        output_format: "png",
      },
    });
    expect(reply).toBe("1 image, 1024 × 1024");
    expect(messages[0].parts).toEqual([
      { type: "text", text: "Make the circle red" },
      {
        type: "file",
        mediaType: "image/png",
        url: "data:image/png;base64,iVBORw0KGgo",
        filename: "circle.png · 1024 × 1024",
      },
      {
        type: "data-missing-media",
        data: {
          kind: "image",
          label: "photo.jpg · 4032 × 3024",
          reason: "Larger than the log keeps (2 MB per image)",
        },
      },
      {
        type: "file",
        mediaType: "image/png",
        url: "data:image/png;base64,iVBORw0KGgoM",
        filename: "Mask: mask.png · 1024 × 1024",
      },
    ]);
    expect(messages[1].parts).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        url: "data:image/png;base64,iVBORw0KGgo",
        filename: "PNG, 1024 × 1024",
      },
    ]);
  });

  it("names an upload a row written before uploads were kept", () => {
    const { messages } = conversation({
      type: "openai:images",
      model: "gpt-image-1-mini",
      request: {
        prompt: "Make the circle red",
        input_files: {
          images: [{ filename: "circle.png", width: 1024, height: 1024 }],
        },
      },
      response: { data: [{ b64_json: "iVBORw0KGgo" }] },
    });
    expect(messages[0].parts[1]).toEqual({
      type: "data-missing-media",
      data: {
        kind: "image",
        label: "circle.png · 1024 × 1024",
        reason: "Not kept in the log",
      },
    });
  });

  it("plays speech and transcription audio, and says when it was not kept", () => {
    const speech = conversation({
      type: "openai:audio",
      model: "tts-1",
      request: { model: "tts-1", operation: "speech", input_characters: 5 },
      response: {
        operation: "speech",
        speech_input: "Hello",
        audio: { content_type: "audio/mpeg", data: "SUQz" },
      },
    });
    expect(speech.title).toBe("Hello");
    expect(speech.messages[1].parts).toEqual([
      {
        type: "file",
        mediaType: "audio/mpeg",
        url: "data:audio/mpeg;base64,SUQz",
        filename: "Speech, MP3",
      },
    ]);

    const transcription = conversation({
      type: "openai:audio",
      model: "whisper-1",
      request: {
        operation: "translations",
        file: { filename: "hello.mp3", size: 17664, duration_seconds: 1.104 },
      },
      response: {
        operation: "translations",
        transcript: "Hello from Archestra.",
        upload: { content_type: "audio/mpeg", data: "SUQz" },
      },
    });
    expect(transcription.messages).toEqual([
      {
        role: "user",
        parts: [
          {
            type: "file",
            mediaType: "audio/mpeg",
            url: "data:audio/mpeg;base64,SUQz",
            filename: "hello.mp3, 1.1 s",
          },
        ],
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "Hello from Archestra." }],
      },
    ]);

    const tooLong = conversation({
      type: "openai:audio",
      model: "whisper-1",
      request: { operation: "transcriptions", file: { filename: "talk.mp3" } },
      response: { operation: "transcriptions", upload_omitted: "too_large" },
    });
    expect(tooLong.messages[0].parts).toEqual([
      {
        type: "data-missing-media",
        data: {
          kind: "audio",
          label: "talk.mp3",
          reason: "Longer than the log keeps (2 MB per clip)",
        },
      },
    ]);
  });

  it("plays a streamed spoken reply as WAV above its transcript", () => {
    const { messages } = conversation({
      type: "openai:chatCompletions",
      model: "gpt-audio",
      request: {
        model: "gpt-audio",
        audio: { voice: "alloy", format: "pcm16" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "input_audio",
                input_audio: { data: "UklG", format: "wav" },
              },
            ],
          },
        ],
      },
      response: {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: null,
              audio: { id: "audio_1", data: "AAAA", transcript: "Hi there." },
            },
          },
        ],
      },
    });
    expect(messages[0].parts).toEqual([
      {
        type: "file",
        mediaType: "audio/wav",
        url: "data:audio/wav;base64,UklG",
        filename: "Audio, WAV",
      },
    ]);
    const [spoken, transcript] = messages[1].parts as Array<{
      type: string;
      url?: string;
      text?: string;
    }>;
    expect(spoken).toMatchObject({ type: "file", mediaType: "audio/wav" });
    // The PCM is wrapped in a 44-byte WAV header.
    const wav = Buffer.from(spoken.url?.split(",")[1] ?? "", "base64");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.length).toBe(44 + 3);
    expect(transcript).toEqual({ type: "text", text: "Hi there." });
  });

  it("plays a realtime response's audio with its length", () => {
    const pcm = Buffer.alloc(48_000).toString("base64");
    const { messages } = conversation({
      type: "openai:realtime",
      model: "gpt-realtime",
      request: { model: "gpt-realtime", turn: 1, input_text: "Say hello." },
      response: {
        id: "resp_1",
        status: "completed",
        output_transcript: "Hello!",
        output_audio: { format: "pcm16", sample_rate: 24000, data: pcm },
      },
    });
    expect(messages[1].parts).toEqual([
      expect.objectContaining({
        type: "file",
        mediaType: "audio/wav",
        filename: "Spoken reply, 1 s",
      }),
      { type: "text", text: "Hello!" },
    ]);
  });

  it("shows a Responses prompt sent as a plain string", () => {
    const { messages, title } = conversation({
      type: "openai:responses",
      model: "gpt-4o-mini",
      request: { model: "gpt-4o-mini", input: "Reply with exactly: hi" },
      response: {
        id: "resp_1",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "hi" }],
          },
        ],
      },
    });
    expect(title).toBe("Reply with exactly: hi");
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
  });
});
