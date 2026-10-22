import { describe, expect, test } from "vitest";
import { azureModelEvidence } from "./azure-models";

describe("Azure backing-model evidence", () => {
  test.each([
    ["gpt-image-1", "image", ["image-generation", "image-edit"]],
    ["dall-e-3", "image", ["image-generation"]],
    ["gpt-audio-1.5", "audio", ["chat"]],
    ["gpt-4o-audio-preview", "audio", ["chat"]],
    ["gpt-realtime", "realtime", ["realtime-turn"]],
    ["gpt-4o-realtime-preview", "realtime", ["realtime-turn"]],
    ["gpt-realtime-translate", "translation", ["realtime-turn"]],
    ["tts-1-hd", "audio", ["audio-speech"]],
    ["gpt-4o-mini-tts", "audio", ["audio-speech"]],
    ["whisper-1", "audio", ["audio-transcription", "audio-translation"]],
    ["gpt-4o-transcribe-diarize", "audio", ["audio-transcription"]],
    ["text-embedding-3-small", "embedding", ["embedding"]],
    ["DeepSeek-V4-Pro", "text", ["chat", "responses"]],
  ])("classifies the provider-reported backing model %s", (underlyingModelName, kind, operations) => {
    expect(
      azureModelEvidence({
        underlyingModelName: String(underlyingModelName),
        source: "deployment",
      }),
    ).toMatchObject({ kind, operations });
  });

  test("missing or blank backing identity stays unknown", () => {
    expect(azureModelEvidence({ source: "deployment" })).toBeNull();
    expect(
      azureModelEvidence({ source: "deployment", underlyingModelName: " " }),
    ).toBeNull();
    expect(
      azureModelEvidence({
        source: "deployment",
        underlyingModelName: "unclassified-future-model",
      }),
    ).toBeNull();
    expect(
      azureModelEvidence({
        source: "deployment",
        capabilities: { chat_completion: false },
      }),
    ).toBeNull();
  });

  test("explicit provider capability flags can classify an opaque deployment", () => {
    expect(
      azureModelEvidence({
        source: "deployment",
        capabilities: { chat_completion: true },
      }),
    ).toMatchObject({ kind: "text", underlyingModelName: null });
    expect(
      azureModelEvidence({
        source: "deployment",
        capabilities: { image_generation: "true" },
      }),
    ).toMatchObject({ kind: "image", operations: ["image-generation"] });
  });
  test("explicit negative operation evidence overrides a recognized backing family", () => {
    expect(
      azureModelEvidence({
        underlyingModelName: "gpt-audio",
        source: "deployment",
        capabilities: { chat_completion: false },
      })?.operations,
    ).toEqual([]);
    expect(
      azureModelEvidence({
        underlyingModelName: "gpt-image-1",
        source: "deployment",
        capabilities: { image_generation: "false", image_edit: false },
      })?.operations,
    ).toEqual([]);
  });
});
