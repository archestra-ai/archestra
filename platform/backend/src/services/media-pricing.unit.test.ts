import { describe, expect, test } from "vitest";
import {
  mediaTariffCovers,
  priceGeminiImage,
  priceOpenAiAudio,
  priceOpenAiImage,
} from "./media-pricing";

describe("priceOpenAiImage", () => {
  test("prices an edit's text and image input and image output at their own rates", () => {
    // gpt-image-1-mini: $2/M text in, $2.50/M image in, $8/M image out.
    expect(
      priceOpenAiImage({
        model: "gpt-image-1-mini",
        usage: {
          input_tokens: 1034,
          input_tokens_details: { image_tokens: 1024, text_tokens: 10 },
          output_tokens: 272,
          output_tokens_details: { image_tokens: 272, text_tokens: 0 },
        },
      }),
    ).toBe(0.004756);
  });

  test("counts input as text and output as image tokens without a breakdown", () => {
    expect(
      priceOpenAiImage({
        model: "gpt-image-1-mini",
        usage: { input_tokens: 14, output_tokens: 272 },
      }),
    ).toBe(0.002204);
    // gpt-image-2: $5/M text in, $30/M image out; dated snapshots bill alike.
    expect(
      priceOpenAiImage({
        model: "gpt-image-2-2026-04-21",
        usage: { input_tokens: 14, output_tokens: 229 },
      }),
    ).toBe(0.00694);
  });

  test("leaves an unknown model or missing usage unpriced", () => {
    expect(
      priceOpenAiImage({
        model: "dall-e-3",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ).toBeUndefined();
    expect(
      priceOpenAiImage({ model: "gpt-image-2", usage: undefined }),
    ).toBeUndefined();
  });
});

describe("priceGeminiImage", () => {
  test("prices Nano Banana image output apart from its input", () => {
    // $0.30/M input, $30/M image output: one 1290-token image is $0.0387.
    expect(
      priceGeminiImage({
        model: "gemini-2.5-flash-image",
        usage: {
          promptTokenCount: 14,
          candidatesTokenCount: 1290,
          candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1290 }],
        },
      }),
    ).toBe(0.0387042);
  });

  test("prices text and thinking output at the text rate", () => {
    expect(
      priceGeminiImage({
        model: "gemini-2.5-flash-image-001",
        usage: {
          promptTokenCount: 0,
          candidatesTokenCount: 1300,
          thoughtsTokenCount: 100,
          candidatesTokensDetails: [
            { modality: "IMAGE", tokenCount: 1290 },
            { modality: "TEXT", tokenCount: 10 },
          ],
        },
      }),
    ).toBe(0.038975);
  });
});

describe("priceOpenAiAudio", () => {
  test("prices speech per input character", () => {
    // tts-1: $15 per million characters.
    expect(
      priceOpenAiAudio({
        model: "tts-1",
        operation: "audio-speech",
        input: "Hello from Archestra",
      }),
    ).toBe(0.0003);
  });

  test("prices token-metered speech only when the response reports usage", () => {
    expect(
      priceOpenAiAudio({
        model: "gpt-4o-mini-tts",
        operation: "audio-speech",
        input: "Hello",
        usage: { input_tokens: 4, output_tokens: 49 },
      }),
    ).toBe(0.0005904);
    expect(
      priceOpenAiAudio({
        model: "gpt-4o-mini-tts",
        operation: "audio-speech",
        input: "Hello",
      }),
    ).toBeUndefined();
  });

  test("prices transcription per minute or per token, as the model is metered", () => {
    // whisper-1: $0.006 per minute, from the reported duration.
    expect(
      priceOpenAiAudio({
        model: "whisper-1",
        operation: "audio-transcription",
        usage: { type: "duration", seconds: 2 },
      }),
    ).toBe(0.0002);
    // gpt-4o-transcribe: $2.50/M input, $10/M output.
    expect(
      priceOpenAiAudio({
        model: "gpt-4o-transcribe",
        operation: "audio-transcription",
        usage: { type: "tokens", input_tokens: 12, output_tokens: 7 },
      }),
    ).toBe(0.0001);
    expect(
      priceOpenAiAudio({
        model: "whisper-1",
        operation: "audio-translation",
        usage: { type: "duration", seconds: 2 },
      }),
    ).toBeUndefined();
  });
});

describe("mediaTariffCovers", () => {
  test("covers the request shapes whose responses report what is billed", () => {
    expect(
      mediaTariffCovers({
        provider: "openai",
        model: "gpt-image-1-mini",
        operation: "image-edit",
      }),
    ).toBe(true);
    expect(
      mediaTariffCovers({
        provider: "gemini",
        model: "gemini-2.5-flash-image",
        operation: "image-generation",
      }),
    ).toBe(true);
    expect(
      mediaTariffCovers({
        provider: "openai",
        model: "tts-1",
        operation: "audio-speech",
      }),
    ).toBe(true);
    expect(
      mediaTariffCovers({
        provider: "openai",
        model: "gpt-4o-mini-tts",
        operation: "audio-speech",
      }),
    ).toBe(false);
    expect(
      mediaTariffCovers({
        provider: "openai",
        model: "whisper-1",
        operation: "audio-transcription",
        responseFormat: "text",
      }),
    ).toBe(false);
    expect(
      mediaTariffCovers({
        provider: "openai",
        model: "whisper-1",
        operation: "audio-translation",
      }),
    ).toBe(false);
  });
});
