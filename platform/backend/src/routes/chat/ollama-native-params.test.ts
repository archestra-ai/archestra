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
});
