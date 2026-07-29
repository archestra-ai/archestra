import { describe, expect, test } from "vitest";
import {
  AWS_PRICE_IDENTITY,
  resolveBedrockAwsPrices,
} from "./bedrock-aws-pricing";

function resolve(modelId: string, underlyingModelName?: string) {
  return resolveBedrockAwsPrices({
    provider: "bedrock",
    modelId,
    underlyingModelName,
  });
}

describe("resolveBedrockAwsPrices", () => {
  test("prices a regional endpoint above the global one", () => {
    const regional = resolve("us.anthropic.claude-sonnet-4-5-20250929-v1:0");
    const global = resolve("global.anthropic.claude-sonnet-4-5-20250929-v1:0");

    // Bedrock charges a 10% premium for guaranteed regional routing; the
    // registry publishes one price and cannot express the difference.
    expect(global?.promptPricePerToken).toBe("0.000003");
    expect(global?.completionPricePerToken).toBe("0.000015");
    expect(regional?.promptPricePerToken).toBe("0.0000033");
    expect(regional?.completionPricePerToken).toBe("0.0000165");
  });

  test("prices a model the registry does not carry at all", () => {
    // Retired from models.dev, so this previously fell to the flat estimate.
    expect(resolve("us.anthropic.claude-3-sonnet-20240229-v1:0")).toEqual({
      promptPricePerToken: "0.000003",
      completionPricePerToken: "0.000015",
    });
  });

  test("keeps two Amazon generations that differ only by `-vN` distinct", () => {
    // `-v1`/`-v2` is part of an Amazon model's name, not a Bedrock revision:
    // these are different models priced five times apart.
    expect(resolve("amazon.titan-embed-text-v1")?.promptPricePerToken).toBe(
      "1e-7",
    );
    expect(resolve("amazon.titan-embed-text-v2:0")?.promptPricePerToken).toBe(
      "2e-8",
    );
  });

  test("bills no output tokens for a model AWS prices on input alone", () => {
    expect(resolve("amazon.titan-embed-text-v1")?.completionPricePerToken).toBe(
      "0",
    );
  });

  test("selects the standard on-demand tier, not batch or flex", () => {
    // Nova Premier also publishes flex at $1.25/M and batch at $1.25/M.
    expect(resolve("us.amazon.nova-premier-v1:0")).toEqual({
      promptPricePerToken: "0.0000025",
      completionPricePerToken: "0.0000125",
    });
  });

  test("normalizes a price published per 1K tokens", () => {
    // Non-Anthropic listings are published per 1K; Llama 3.2 90B is $0.00072/1K.
    expect(resolve("us.meta.llama3-2-90b-instruct-v1:0")).toEqual({
      promptPricePerToken: "7.2e-7",
      completionPricePerToken: "7.2e-7",
    });
  });

  test("resolves an application inference profile through its foundation model", () => {
    // An application profile's own id encodes nothing about the model.
    const prices = resolve(
      "hq8s2mfl9k1r",
      "anthropic.claude-sonnet-4-5-20250929-v1:0",
    );

    expect(prices?.promptPricePerToken).toBe("0.0000033");
  });

  test("returns null for a model AWS does not price", () => {
    expect(resolve("cohere.rerank-v3-5:0")).toBeNull();
    expect(resolve("us.made.up-model-v1:0")).toBeNull();
  });

  test("returns null for a provider other than bedrock", () => {
    expect(
      resolveBedrockAwsPrices({
        provider: "anthropic",
        modelId: "claude-sonnet-4-5",
      }),
    ).toBeNull();
  });

  test("does not price a model AWS omits by falling back to a generic entry", () => {
    // AWS lists no Opus 4.7/4.8/5, Sonnet 5 or Fable 5. Their names share a
    // prefix with the legacy "Claude" and "Claude Opus 4" listings, whose prices
    // are three to four times wrong for them, so each must resolve to nothing
    // and let the registry price it.
    for (const modelId of [
      "us.anthropic.claude-opus-4-8",
      "us.anthropic.claude-opus-4-7",
      "us.anthropic.claude-opus-5",
      "us.anthropic.claude-sonnet-5",
      "us.anthropic.claude-fable-5",
    ]) {
      expect(resolve(modelId)).toBeNull();
    }
  });

  test("every mapped identity is priced, and none is a bare family name", () => {
    // A generic listing such as "Claude" or "Claude Opus 4" prices a whole
    // family at one legacy rate; mapping a specific model onto one is the
    // failure this guards.
    const GENERIC = new Set(["Claude", "Claude Opus 4", "Amazon Bedrock"]);
    for (const [modelId, identity] of Object.entries(AWS_PRICE_IDENTITY)) {
      expect(GENERIC.has(identity)).toBe(false);
      // The identity is transcribed from AWS by hand, so a typo — or a listing
      // AWS renames on a later refresh — resolves to nothing and drops the
      // model onto the fabricated estimate without failing anything else.
      expect(resolve(modelId)).not.toBeNull();
    }
  });
});
