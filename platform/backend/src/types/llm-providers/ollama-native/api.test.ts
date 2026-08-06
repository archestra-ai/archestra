import { describe, expect, test } from "vitest";
import {
  ChatRequestSchema,
  ChatResponseSchema,
  MAX_KEEP_ALIVE_SECONDS,
  OptionsSchema,
} from "./api";

describe("OptionsSchema", () => {
  test("keeps the sampling and context knobs", () => {
    const parsed = OptionsSchema.parse({
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      min_p: 0.05,
      typical_p: 1,
      seed: 42,
      repeat_penalty: 1.1,
      repeat_last_n: 64,
      presence_penalty: 0,
      frequency_penalty: 0,
      stop: ["END"],
      num_keep: 4,
      num_ctx: 8192,
      num_predict: 1024,
    });

    // num_ctx / num_predict in particular: being able to send these is the
    // whole reason the native provider exists — `/v1` discards them.
    expect(parsed.num_ctx).toBe(8192);
    expect(parsed.num_predict).toBe(1024);
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.stop).toEqual(["END"]);
  });

  test("strips the host-resource knobs", () => {
    const parsed = OptionsSchema.parse({
      num_ctx: 4096,
      num_gpu: 99,
      main_gpu: 1,
      num_batch: 8192,
      num_thread: 64,
      use_mmap: false,
      use_mlock: true,
      low_vram: false,
    });

    // These configure the shared inference host rather than the request: on a
    // multi-tenant Ollama any caller with a virtual key could otherwise exhaust
    // VRAM or force repeated model reloads for everyone else.
    expect(parsed).toEqual({ num_ctx: 4096 });
  });

  test("rejects an absurd num_ctx rather than forwarding it", () => {
    expect(() => OptionsSchema.parse({ num_ctx: 100_000_000 })).toThrow();
    expect(() => OptionsSchema.parse({ num_ctx: 0 })).toThrow();
    expect(() => OptionsSchema.parse({ num_ctx: 8192.5 })).toThrow();
  });

  test("accepts Ollama's num_predict sentinels but not other negatives", () => {
    expect(OptionsSchema.parse({ num_predict: -1 }).num_predict).toBe(-1);
    expect(OptionsSchema.parse({ num_predict: -2 }).num_predict).toBe(-2);
    expect(() => OptionsSchema.parse({ num_predict: -3 })).toThrow();
  });
});

describe("keep_alive clamping", () => {
  test("clamps a long duration string to the ceiling", () => {
    const parsed = ChatRequestSchema.parse({
      model: "llama3.2",
      messages: [],
      keep_alive: "9999h",
    });
    expect(parsed.keep_alive).toBe(MAX_KEEP_ALIVE_SECONDS);
  });

  test("treats a negative value as indefinite and clamps it", () => {
    // Ollama reads any negative duration as "keep loaded forever".
    expect(
      ChatRequestSchema.parse({
        model: "m",
        messages: [],
        keep_alive: -1,
      }).keep_alive,
    ).toBe(MAX_KEEP_ALIVE_SECONDS);
    expect(
      ChatRequestSchema.parse({
        model: "m",
        messages: [],
        keep_alive: "-1s",
      }).keep_alive,
    ).toBe(MAX_KEEP_ALIVE_SECONDS);
  });

  test("passes a reasonable duration through, normalized to seconds", () => {
    expect(
      ChatRequestSchema.parse({ model: "m", messages: [], keep_alive: "5m" })
        .keep_alive,
    ).toBe(300);
    expect(
      ChatRequestSchema.parse({ model: "m", messages: [], keep_alive: 120 })
        .keep_alive,
    ).toBe(120);
  });

  test("clamps an unparseable duration rather than forwarding it", () => {
    expect(
      ChatRequestSchema.parse({
        model: "m",
        messages: [],
        keep_alive: "forever",
      }).keep_alive,
    ).toBe(MAX_KEEP_ALIVE_SECONDS);
  });
});

describe("ChatRequestSchema", () => {
  test("strips resource knobs nested under options on a full request", () => {
    const parsed = ChatRequestSchema.parse({
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
      options: { num_ctx: 8192, num_gpu: 99, num_batch: 8192 },
      keep_alive: "10m",
    });

    expect(parsed.options).toEqual({ num_ctx: 8192 });
    expect(parsed.keep_alive).toBe(600);
  });

  test("keeps the tool_name field the native wire uses to name results", () => {
    const parsed = ChatRequestSchema.parse({
      model: "llama3.2",
      messages: [{ role: "tool", tool_name: "fetch_url", content: "body" }],
    });
    expect(parsed.messages[0].tool_name).toBe("fetch_url");
  });

  // Go's encoding/json matches struct fields "exact first, then
  // case-insensitive", so a variant-cased key binds to the same Ollama field
  // and — arriving later in the object — overwrites the sanitized value. That
  // silently undoes the OptionsSchema strip and the keep_alive clamp.
  describe("case-variant key bypass", () => {
    const base = {
      model: "llama3.2",
      messages: [{ role: "user", content: "hi" }],
    };

    test("drops a variant-cased duplicate of a guarded key", () => {
      const parsed = ChatRequestSchema.parse({
        ...base,
        options: { num_ctx: 4096 },
        keep_alive: 300,
        Options: { num_gpu: 0, num_thread: 64 },
        Keep_alive: -1,
      });

      expect(parsed.options).toEqual({ num_ctx: 4096 });
      expect(parsed.keep_alive).toBe(300);
      expect(parsed).not.toHaveProperty("Options");
      expect(parsed).not.toHaveProperty("Keep_alive");
    });

    test("drops a lone variant with no lowercase sibling", () => {
      // The nastier shape: with no `options` key at all, Go still binds
      // `Options` to the same field, so the guard is bypassed outright.
      const parsed = ChatRequestSchema.parse({
        ...base,
        OPTIONS: { num_gpu: 0 },
      });
      expect(parsed).not.toHaveProperty("OPTIONS");
      expect(parsed).not.toHaveProperty("options");
    });

    test("guards every field, not just options and keep_alive", () => {
      const parsed = ChatRequestSchema.parse({
        ...base,
        stream: false,
        Stream: true,
        Think: true,
        Model: "other-model",
      });
      expect(parsed.stream).toBe(false);
      expect(parsed.model).toBe("llama3.2");
      expect(parsed).not.toHaveProperty("Stream");
      expect(parsed).not.toHaveProperty("Think");
      expect(parsed).not.toHaveProperty("Model");
    });

    test("still forwards unknown keys that collide with nothing", () => {
      // The looseObject is deliberate — Ollama keeps adding fields and the
      // proxy stays transparent to them.
      const parsed = ChatRequestSchema.parse({
        ...base,
        logprobs: true,
        _debug_render_only: true,
      });
      expect(parsed.logprobs).toBe(true);
      expect(parsed._debug_render_only).toBe(true);
    });
  });
});

describe("ChatResponseSchema", () => {
  test("accepts a tool-call reply that omits message.content", () => {
    const result = ChatResponseSchema.safeParse({
      model: "llama3.2",
      message: {
        role: "assistant",
        tool_calls: [
          {
            function: {
              name: "search",
              arguments: { q: "hi" },
            },
          },
        ],
      },
      done: true,
    });
    expect(result.success).toBe(true);
  });
});
