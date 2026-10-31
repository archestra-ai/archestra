import { describe, expect, test } from "vitest";
import {
  mediaPricingFor,
  mediaTariffCovers,
  priceGeminiImage,
  priceOpenAiAudio,
  priceOpenAiAudioChat,
  priceOpenAiImage,
  priceOpenAiRealtime,
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
  });

  test("prices a response without usage from the upload's duration, rounded up to the second", () => {
    // A text transcript of 1.248 s bills as the 2 s OpenAI reports for it.
    expect(
      priceOpenAiAudio({
        model: "whisper-1",
        operation: "audio-transcription",
        audioSeconds: 1.248,
      }),
    ).toBe(0.0002);
    // Translations report nothing; whisper-1 bills them per minute too.
    expect(
      priceOpenAiAudio({
        model: "whisper-1",
        operation: "audio-translation",
        audioSeconds: 3,
      }),
    ).toBe(0.0003);
    // A token-metered model without tokens: OpenAI's per-minute estimate,
    // $0.003 for gpt-4o-mini-transcribe.
    expect(
      priceOpenAiAudio({
        model: "gpt-4o-mini-transcribe",
        operation: "audio-transcription",
        audioSeconds: 60,
      }),
    ).toBe(0.003);
    // Reported usage wins over the measurement.
    expect(
      priceOpenAiAudio({
        model: "gpt-4o-transcribe",
        operation: "audio-transcription",
        usage: { input_tokens: 12, output_tokens: 7 },
        audioSeconds: 60,
      }),
    ).toBe(0.0001);
    expect(
      priceOpenAiAudio({
        model: "whisper-1",
        operation: "audio-translation",
      }),
    ).toBeUndefined();
  });
});

describe("priceOpenAiAudioChat", () => {
  test("prices the audio tokens of an audio chat response apart from its text", () => {
    // gpt-audio: $2.50/M text in, $32/M audio in, $10/M text out, $64/M audio out.
    expect(
      priceOpenAiAudioChat({
        model: "gpt-audio-2025-08-28",
        usage: {
          prompt_tokens: 120,
          completion_tokens: 260,
          prompt_tokens_details: { audio_tokens: 100, text_tokens: 20 },
          completion_tokens_details: { audio_tokens: 250, text_tokens: 10 },
        },
      }),
    ).toBe(0.01935);
  });

  test("leaves a text-only response and an unknown model to the chat price", () => {
    expect(
      priceOpenAiAudioChat({
        model: "gpt-audio",
        usage: { prompt_tokens: 12, completion_tokens: 8 },
      }),
    ).toBeUndefined();
    expect(
      priceOpenAiAudioChat({
        model: "gpt-4o-audio-preview",
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          prompt_tokens_details: { audio_tokens: 10 },
        },
      }),
    ).toBeUndefined();
  });
});

describe("priceOpenAiRealtime", () => {
  test("prices each input modality, cached input and each output modality at its own rate", () => {
    // gpt-realtime-2.1: text $4 in / $24 out, audio $32 in / $64 out, image $5 in,
    // cached text and audio $0.40. 20 of the 70 text and 50 of the 250 audio
    // input tokens were cached.
    expect(
      priceOpenAiRealtime({
        model: "gpt-realtime-2.1",
        usage: {
          input_tokens: 330,
          output_tokens: 160,
          input_token_details: {
            text_tokens: 70,
            audio_tokens: 250,
            image_tokens: 10,
            cached_tokens: 70,
            cached_tokens_details: { text_tokens: 20, audio_tokens: 50 },
          },
          output_token_details: { text_tokens: 10, audio_tokens: 150 },
        },
      }),
    ).toBe(0.016518);
  });

  test("leaves a translation session and a usage-less response unpriced", () => {
    expect(
      priceOpenAiRealtime({
        model: "gpt-realtime-translate",
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    ).toBeUndefined();
    expect(
      priceOpenAiRealtime({ model: "gpt-realtime", usage: undefined }),
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
    // A measured upload covers what the response will not report.
    for (const operation of [
      "audio-transcription",
      "audio-translation",
    ] as const) {
      expect(
        mediaTariffCovers({
          provider: "openai",
          model: "whisper-1",
          operation,
          responseFormat: "text",
          audioSeconds: 3,
        }),
      ).toBe(true);
    }
  });
});

describe("mediaPricingFor", () => {
  test("states each media model's rates in the unit it is billed by", () => {
    expect(mediaPricingFor("openai", "gpt-image-1")).toEqual({
      per: "million_tokens",
      input: [
        { kind: "text", usd: 5 },
        { kind: "image", usd: 10 },
      ],
      output: [{ kind: "image", usd: 40 }],
    });
    expect(mediaPricingFor("openai", "gpt-realtime-mini")).toEqual({
      per: "million_tokens",
      input: [
        { kind: "text", usd: 0.6 },
        { kind: "audio", usd: 10 },
        { kind: "image", usd: 0.8 },
      ],
      output: [
        { kind: "text", usd: 2.4 },
        { kind: "audio", usd: 20 },
      ],
    });
    expect(mediaPricingFor("openai", "gpt-audio-mini")).toEqual({
      per: "million_tokens",
      input: [
        { kind: "text", usd: 0.6 },
        { kind: "audio", usd: 10 },
      ],
      output: [
        { kind: "text", usd: 2.4 },
        { kind: "audio", usd: 20 },
      ],
    });
    expect(mediaPricingFor("azure", "tts-1-hd-1106")).toEqual({
      per: "million_characters",
      input: [{ kind: "text", usd: 30 }],
      output: [],
    });
    expect(mediaPricingFor("openai", "whisper-1")).toEqual({
      per: "minute",
      input: [{ kind: "audio", usd: 0.006 }],
      output: [],
    });
    expect(
      mediaPricingFor("openai", "gpt-4o-mini-transcribe-2025-12-15"),
    ).toEqual({
      per: "million_tokens",
      input: [{ kind: "audio", usd: 1.25 }],
      output: [{ kind: "text", usd: 5 }],
    });
    expect(mediaPricingFor("gemini", "gemini-3-pro-image-preview")).toEqual({
      per: "million_tokens",
      input: [{ kind: "text_and_image", usd: 2 }],
      output: [
        { kind: "image", usd: 120 },
        { kind: "text", usd: 12 },
      ],
    });
  });

  test("returns null for chat models and for providers it does not price", () => {
    expect(mediaPricingFor("openai", "gpt-4o-mini")).toBeNull();
    expect(mediaPricingFor("anthropic", "gpt-image-1")).toBeNull();
    expect(mediaPricingFor("gemini", "gemini-2.5-flash")).toBeNull();
  });
});
