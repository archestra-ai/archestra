import { describe, expect, test } from "@/test";
import { buildOllamaNativeProviderOptions } from "./ollama-native-params";

describe("buildOllamaNativeProviderOptions", () => {
  test("returns undefined when there is nothing to send", () => {
    expect(
      buildOllamaNativeProviderOptions({ configured: null }),
    ).toBeUndefined();
    expect(
      buildOllamaNativeProviderOptions({ configured: {} }),
    ).toBeUndefined();
  });

  test("forwards the native sampling options", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: {
        num_ctx: 8192,
        num_predict: 1024,
        top_k: 40,
        top_p: 0.9,
        repeat_penalty: 1.1,
        seed: 7,
        stop: ["END"],
        temperature: 0.5,
      },
    });
    expect(result).toEqual({
      ollama: {
        options: {
          num_ctx: 8192,
          num_predict: 1024,
          top_k: 40,
          top_p: 0.9,
          repeat_penalty: 1.1,
          seed: 7,
          stop: ["END"],
          temperature: 0.5,
        },
      },
    });
  });

  test("omits unset fields so Ollama's own defaults are inherited", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { num_ctx: 4096 },
    });
    expect(result).toEqual({ ollama: { options: { num_ctx: 4096 } } });
  });

  test("maps reasoning effort to a boolean think (v6 package constraint)", () => {
    expect(
      buildOllamaNativeProviderOptions({
        configured: { reasoning_effort: "none" },
      }),
    ).toEqual({ ollama: { think: false } });
    expect(
      buildOllamaNativeProviderOptions({
        configured: { reasoning_effort: "medium" },
      }),
    ).toEqual({ ollama: { think: true } });
  });

  test("a request-body temperature overrides the configured one", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { temperature: 0.2, num_ctx: 2048 },
      requestTemperature: 0.9,
    });
    expect(result?.ollama.options?.temperature).toBe(0.9);
    expect(result?.ollama.options?.num_ctx).toBe(2048);
  });

  test("falsy sampling values survive (0 is a meaningful setting)", () => {
    // Guards against a future `||` refactor: `temperature: 0` is greedy
    // decoding and `seed: 0` is a valid fixed seed, so neither may be dropped.
    const result = buildOllamaNativeProviderOptions({
      configured: { temperature: 0, top_p: 0, seed: 0, top_k: 0 },
    });
    expect(result?.ollama.options).toEqual({
      temperature: 0,
      top_p: 0,
      seed: 0,
      top_k: 0,
    });
  });

  test("an unset reasoning_effort omits `think` entirely", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { num_ctx: 4096 },
    });
    expect(result?.ollama).not.toHaveProperty("think");
  });
});

describe("output budget → options.num_predict", () => {
  // Ollama caps output via `options.num_predict`. The AI SDK's `maxOutputTokens`
  // is emitted top-level as `max_output_tokens`, which the native endpoint
  // discards — so without this the operator ceiling never reaches the model.
  test("the resolved budget becomes num_predict when nothing is configured", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: null,
      maxOutputTokens: 4096,
    });
    expect(result?.ollama.options?.num_predict).toBe(4096);
  });

  test("the tighter of budget and configured value wins", () => {
    expect(
      buildOllamaNativeProviderOptions({
        configured: { num_predict: 512 },
        maxOutputTokens: 4096,
      })?.ollama.options?.num_predict,
    ).toBe(512);

    expect(
      buildOllamaNativeProviderOptions({
        configured: { num_predict: 8192 },
        maxOutputTokens: 4096,
      })?.ollama.options?.num_predict,
    ).toBe(4096);
  });

  test("Ollama's negative sentinels do not defeat the budget", () => {
    // `-1` = generate until the context fills, `-2` = fill the context. A plain
    // Math.min would pick the sentinel and remove the cap entirely.
    for (const sentinel of [-1, -2]) {
      expect(
        buildOllamaNativeProviderOptions({
          configured: { num_predict: sentinel },
          maxOutputTokens: 4096,
        })?.ollama.options?.num_predict,
      ).toBe(4096);
    }
  });

  test("a configured sentinel survives when there is no budget", () => {
    expect(
      buildOllamaNativeProviderOptions({
        configured: { num_predict: -1 },
      })?.ollama.options?.num_predict,
    ).toBe(-1);
  });

  test("no budget and no configured value omits num_predict", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { num_ctx: 4096 },
    });
    expect(result?.ollama.options).not.toHaveProperty("num_predict");
  });
});
