import { OLLAMA_THINK_EXPLICIT_HEADER } from "@/clients/llm-client";
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
    expect(result?.providerOptions).toEqual({
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
    expect(result?.headers).toBeUndefined();
  });

  test("omits unset fields so Ollama's own defaults are inherited", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { num_ctx: 4096 },
    });
    expect(result?.providerOptions).toEqual({
      ollama: { options: { num_ctx: 4096 } },
    });
  });

  test("maps reasoning effort to a boolean think (v6 package constraint)", () => {
    expect(
      buildOllamaNativeProviderOptions({
        configured: { reasoning_effort: "none" },
      })?.providerOptions,
    ).toEqual({ ollama: { think: false } });
    expect(
      buildOllamaNativeProviderOptions({
        configured: { reasoning_effort: "medium" },
      })?.providerOptions,
    ).toEqual({ ollama: { think: true } });
  });

  test("a request-body temperature overrides the configured one", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { temperature: 0.2, num_ctx: 2048 },
      requestTemperature: 0.9,
    });
    expect(result?.providerOptions.ollama.options?.temperature).toBe(0.9);
    expect(result?.providerOptions.ollama.options?.num_ctx).toBe(2048);
  });

  test("falsy sampling values survive (0 is a meaningful setting)", () => {
    // Guards against a future `||` refactor: `temperature: 0` is greedy
    // decoding and `seed: 0` is a valid fixed seed, so neither may be dropped.
    const result = buildOllamaNativeProviderOptions({
      configured: { temperature: 0, top_p: 0, seed: 0, top_k: 0 },
    });
    expect(result?.providerOptions.ollama.options).toEqual({
      temperature: 0,
      top_p: 0,
      seed: 0,
      top_k: 0,
    });
  });

  // These pin the *intent* signal only. The wire behaviour lives in
  // `createOllamaNativeFetch` (clients/llm-client.test.ts): the package emits
  // `think: ollamaOptions?.think ?? false` regardless of what is set here, so an
  // assertion on this bag alone cannot tell whether thinking is actually on.
  test("an unset reasoning_effort sets neither `think` nor the explicit header", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { num_ctx: 4096 },
    });
    expect(result?.providerOptions.ollama).not.toHaveProperty("think");
    expect(result?.headers).toBeUndefined();
  });

  test("an explicit reasoning_effort marks the choice as deliberate", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { reasoning_effort: "medium" },
    });
    expect(result?.providerOptions.ollama.think).toBe(true);
    expect(result?.headers?.[OLLAMA_THINK_EXPLICIT_HEADER]).toBe("1");
  });

  test('"none" is a deliberate choice, so the marker still rides along', () => {
    // Without the marker this would be indistinguishable from "unset" and the
    // wrapper would strip `think`, silently turning thinking back on.
    const result = buildOllamaNativeProviderOptions({
      configured: { reasoning_effort: "none" },
    });
    expect(result?.providerOptions.ollama.think).toBe(false);
    expect(result?.headers?.[OLLAMA_THINK_EXPLICIT_HEADER]).toBe("1");
  });

  test("the marker never rides in the options bag", () => {
    // It used to. ollama-ai-provider-v2 parses `providerOptions.ollama` through
    // a closed Zod object, so anything inside `options` that is not one of its
    // ten known keys is stripped before the body is built — the wrapper never
    // saw the marker and unconditionally deleted `think`.
    const result = buildOllamaNativeProviderOptions({
      configured: { reasoning_effort: "none", num_ctx: 4096 },
    });
    expect(result?.providerOptions.ollama.options).toEqual({ num_ctx: 4096 });
  });
});

describe("num_ctx → the effective window", () => {
  test("sends the effective window rather than the raw configured value", () => {
    // `resolveEffectiveContextLength` clamps to the architectural ceiling.
    // Sending the unclamped stored value would let the wire disagree with the
    // context ring and the Models table.
    const result = buildOllamaNativeProviderOptions({
      configured: { num_ctx: 131072 },
      effectiveContextLength: 8192,
    });
    expect(result?.providerOptions.ollama.options?.num_ctx).toBe(8192);
  });

  test("falls back to the configured value when no effective length is known", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { num_ctx: 4096 },
      effectiveContextLength: null,
    });
    expect(result?.providerOptions.ollama.options?.num_ctx).toBe(4096);
  });

  test("sends no num_ctx when the admin configured none", () => {
    // The effective length also covers a Modelfile `num_ctx`, which Ollama
    // already applies on its own — echoing it back would be noise.
    const result = buildOllamaNativeProviderOptions({
      configured: { top_k: 40 },
      effectiveContextLength: 8192,
    });
    expect(result?.providerOptions.ollama.options).not.toHaveProperty(
      "num_ctx",
    );
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
    expect(result?.providerOptions.ollama.options?.num_predict).toBe(4096);
  });

  test("the tighter of budget and configured value wins", () => {
    expect(
      buildOllamaNativeProviderOptions({
        configured: { num_predict: 512 },
        maxOutputTokens: 4096,
      })?.providerOptions.ollama.options?.num_predict,
    ).toBe(512);

    expect(
      buildOllamaNativeProviderOptions({
        configured: { num_predict: 8192 },
        maxOutputTokens: 4096,
      })?.providerOptions.ollama.options?.num_predict,
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
        })?.providerOptions.ollama.options?.num_predict,
      ).toBe(4096);
    }
  });

  test("a configured sentinel survives when there is no budget", () => {
    expect(
      buildOllamaNativeProviderOptions({
        configured: { num_predict: -1 },
      })?.providerOptions.ollama.options?.num_predict,
    ).toBe(-1);
  });

  test("no budget and no configured value omits num_predict", () => {
    const result = buildOllamaNativeProviderOptions({
      configured: { num_ctx: 4096 },
    });
    expect(result?.providerOptions.ollama.options).not.toHaveProperty(
      "num_predict",
    );
  });
});
