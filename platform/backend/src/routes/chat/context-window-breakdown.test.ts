import { describe, expect, it } from "vitest";
import type { ChatMessage } from "@/types";
import {
  BINARY_BYTES_PER_TOKEN,
  buildContextWindowBreakdown,
  CHARS_PER_TOKEN,
  IMAGE_TOKEN_MAX_ESTIMATE,
  PDF_BYTES_PER_TOKEN,
  refreshBreakdownUsedTokens,
  resolveInputPricePerToken,
} from "./context-window-breakdown";

function tokensFor(
  breakdown: ReturnType<typeof buildContextWindowBreakdown>,
  category: string,
): number {
  return (
    breakdown.segments.find((segment) => segment.category === category)
      ?.tokens ?? 0
  );
}

function itemsFor(
  breakdown: ReturnType<typeof buildContextWindowBreakdown>,
  category: string,
) {
  return (
    breakdown.segments.find((segment) => segment.category === category)
      ?.items ?? []
  );
}

describe.skip("buildContextWindowBreakdown", () => {
  const baseParams = {
    provider: "openai" as const,
    model: "gpt-4o",
    contextLength: 128_000,
  };

  // -------------------------------------------------------------------------
  // Empty / edge cases
  // -------------------------------------------------------------------------

  it("returns empty segments and zero usedTokens for an empty conversation", () => {
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      messages: [],
    });

    expect(breakdown.segments).toEqual([]);
    expect(breakdown.usedTokens).toBe(0);
    expect(breakdown.freeTokens).toBe(128_000);
    expect(breakdown.usedPercent).toBe(0);
  });

  it("handles no tools gracefully (no tools segment)", () => {
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      messages: [{ role: "user", parts: [{ type: "text", text: "Hello" }] }],
    });

    expect(tokensFor(breakdown, "tools")).toBe(0);
    expect(breakdown.segments.map((s) => s.category)).not.toContain("tools");
  });

  it("handles messages with no parts without throwing", () => {
    const messages: ChatMessage[] = [{ role: "user", parts: [] }];
    expect(() =>
      buildContextWindowBreakdown({ ...baseParams, messages }),
    ).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Per-category population
  // -------------------------------------------------------------------------

  it("counts the system prompt and user messages in separate categories", () => {
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "Hello there, model" }] },
    ];

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      systemPrompt: "You are a helpful assistant.",
      messages,
    });

    expect(tokensFor(breakdown, "system_prompt")).toBeGreaterThan(0);
    expect(tokensFor(breakdown, "messages")).toBeGreaterThan(0);
    expect(tokensFor(breakdown, "tools")).toBe(0);
  });

  it("attributes tool-prefixed parts to tool_results, not messages", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        parts: [
          {
            type: "tool-search",
            toolName: "search",
            state: "output-available",
            output: { results: ["a", "b", "c"] },
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({ ...baseParams, messages });

    expect(tokensFor(breakdown, "tool_results")).toBeGreaterThan(0);
    expect(tokensFor(breakdown, "messages")).toBe(0);
  });

  it("counts tool schemas from the AI SDK tool map", () => {
    const tools = {
      search: {
        description: "Search the knowledge base for relevant documents",
        inputSchema: {
          jsonSchema: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    };

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      tools,
      messages: [],
    });

    expect(tokensFor(breakdown, "tools")).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Total reconciliation: usedTokens === sum(segments)
  // -------------------------------------------------------------------------

  it("usedTokens always equals the sum of all segment tokens", () => {
    const tools = {
      t1: { description: "tool one", inputSchema: { jsonSchema: {} } },
      t2: { description: "tool two", inputSchema: { jsonSchema: {} } },
    };
    const messages: ChatMessage[] = [
      { role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            toolName: "t1",
            state: "output-available",
            output: { ok: true },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "doc.pdf",
            mediaType: "application/pdf",
            fileSize: 24_000,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      systemPrompt: "You are an assistant.",
      tools,
      messages,
    });

    const segmentSum = breakdown.segments.reduce((sum, s) => sum + s.tokens, 0);
    expect(breakdown.usedTokens).toBe(segmentSum);
  });

  // -------------------------------------------------------------------------
  // Canonical stack order
  // -------------------------------------------------------------------------

  it("keeps segments in canonical stack order (system_prompt → tools → messages → tool_results → files)", () => {
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      systemPrompt: "system",
      tools: {
        t: { description: "a tool", inputSchema: { jsonSchema: {} } },
      },
      messages: [
        { role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          role: "assistant",
          parts: [
            {
              type: "tool-x",
              toolName: "x",
              state: "output-available",
              output: { ok: true },
            },
          ],
        },
      ],
    });

    const order = breakdown.segments.map((s) => s.category);
    expect(order).toEqual([
      "system_prompt",
      "tools",
      "messages",
      "tool_results",
    ]);
  });

  // -------------------------------------------------------------------------
  // "Other (N)" rollup — total conservation
  // -------------------------------------------------------------------------

  it("rolls up the tail into Other (N) and conserves the category total", () => {
    // Build 14 distinct tools to exceed the MAX_ITEMS_PER_CATEGORY cap of 12.
    const tools: Record<string, unknown> = {};
    for (let i = 0; i < 14; i++) {
      tools[`tool_${i}`] = {
        description: `Tool number ${i} with a description long enough to get tokens`,
        inputSchema: {
          jsonSchema: {
            type: "object",
            properties: { input: { type: "string" } },
          },
        },
      };
    }

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      tools,
      messages: [],
    });

    const items = itemsFor(breakdown, "tools");
    const categoryTotal = tokensFor(breakdown, "tools");

    // Should have exactly MAX_ITEMS_PER_CATEGORY items (11 named + 1 Other).
    expect(items).toHaveLength(12);
    const otherItem = items.find((item) => item.label.startsWith("Other ("));
    expect(otherItem).toBeDefined();
    // Items sum must equal category total (conservation invariant).
    const itemSum = items.reduce((sum, item) => sum + item.tokens, 0);
    expect(itemSum).toBe(categoryTotal);
  });

  // -------------------------------------------------------------------------
  // Pricing
  // -------------------------------------------------------------------------

  it("computes estimatedInputCostUsd when inputPricePerToken is provided", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "data.bin",
            mediaType: "application/octet-stream",
            fileSize: 4_000,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      contextLength: 10_000,
      inputPricePerToken: 0.000003,
      messages,
    });

    // 4_000 bytes / 4 bytes-per-token = 1_000 tokens; 1_000 * 0.000003 = 0.003
    expect(breakdown.estimatedInputCostUsd).toBeCloseTo(0.003);
  });

  it("returns null estimatedInputCostUsd when inputPricePerToken is absent", () => {
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    });

    expect(breakdown.estimatedInputCostUsd).toBeNull();
  });

  it("returns null estimatedInputCostUsd when inputPricePerToken is explicitly null", () => {
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      inputPricePerToken: null,
      messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    });

    expect(breakdown.estimatedInputCostUsd).toBeNull();
  });

  // -------------------------------------------------------------------------
  // null contextLength
  // -------------------------------------------------------------------------

  it("reports null freeTokens and usedPercent when contextLength is null", () => {
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      contextLength: null,
      messages: [
        { role: "user", parts: [{ type: "text", text: "anything at all" }] },
      ],
    });

    expect(breakdown.contextLength).toBeNull();
    expect(breakdown.freeTokens).toBeNull();
    expect(breakdown.usedPercent).toBeNull();
    expect(breakdown.usedTokens).toBeGreaterThan(0);
  });

  it("computes used/free/percent correctly against a known contextLength", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "data.bin",
            mediaType: "application/octet-stream",
            fileSize: 4_000,
          },
        ],
      },
    ];

    // 4_000 bytes / BINARY_BYTES_PER_TOKEN(4) = 1_000 tokens
    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      contextLength: 10_000,
      messages,
    });

    expect(breakdown.usedTokens).toBe(1_000);
    expect(breakdown.freeTokens).toBe(9_000);
    expect(breakdown.usedPercent).toBeCloseTo(10);
  });

  it("allows freeTokens to be negative when usedTokens exceeds contextLength", () => {
    // 400_000 bytes / 4 = 100_000 tokens > contextLength 10_000
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "huge.bin",
            mediaType: "application/octet-stream",
            fileSize: 400_000,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({
      ...baseParams,
      contextLength: 10_000,
      messages,
    });

    expect(breakdown.freeTokens).toBeLessThan(0);
    // usedPercent must still be clamped to 100 even when over-limit.
    expect(breakdown.usedPercent).toBe(100);
  });

  // -------------------------------------------------------------------------
  // File byte-length cases
  // -------------------------------------------------------------------------

  it("estimates PDF tokens from fileSize using PDF_BYTES_PER_TOKEN", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "report.pdf",
            mediaType: "application/pdf",
            fileSize: 120_000,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({ ...baseParams, messages });

    expect(tokensFor(breakdown, "files")).toBe(
      Math.ceil(120_000 / PDF_BYTES_PER_TOKEN),
    );
  });

  it("estimates plain-text file tokens using CHARS_PER_TOKEN", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "notes.txt",
            mediaType: "text/plain",
            fileSize: 8_000,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({ ...baseParams, messages });

    expect(tokensFor(breakdown, "files")).toBe(
      Math.ceil(8_000 / CHARS_PER_TOKEN),
    );
  });

  it("estimates binary file tokens using BINARY_BYTES_PER_TOKEN", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "archive.zip",
            mediaType: "application/octet-stream",
            fileSize: 40_000,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({ ...baseParams, messages });

    expect(tokensFor(breakdown, "files")).toBe(
      Math.ceil(40_000 / BINARY_BYTES_PER_TOKEN),
    );
  });

  it("caps image token estimate at IMAGE_TOKEN_MAX_ESTIMATE regardless of byte size", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "photo.jpg",
            mediaType: "image/jpeg",
            // 4 MB — would be 1_000_000 tokens uncapped
            fileSize: 4_000_000,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({ ...baseParams, messages });

    expect(tokensFor(breakdown, "files")).toBe(IMAGE_TOKEN_MAX_ESTIMATE);
  });

  it("measures base64 data URL byte length correctly", () => {
    // 'Hello' base64 encoded = 'SGVsbG8=' (8 chars) → floor(8*3/4) = 6 bytes
    // 6 bytes text → ceil(6 / CHARS_PER_TOKEN) = 2 tokens
    const b64 = Buffer.from("Hello").toString("base64"); // "SGVsbG8="
    const dataUrl = `data:text/plain;base64,${b64}`;
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "hello.txt",
            mediaType: "text/plain",
            url: dataUrl,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({ ...baseParams, messages });

    const expectedBytes = Math.floor((b64.length * 3) / 4);
    expect(tokensFor(breakdown, "files")).toBe(
      Math.ceil(expectedBytes / CHARS_PER_TOKEN),
    );
  });

  it("measures URL-encoded (non-base64) data URL byte length as payload char count", () => {
    const text = "hello world";
    const encoded = encodeURIComponent(text); // "hello%20world" = 13 chars
    const dataUrl = `data:text/plain,${encoded}`;
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "hw.txt",
            mediaType: "text/plain",
            url: dataUrl,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({ ...baseParams, messages });

    expect(tokensFor(breakdown, "files")).toBe(
      Math.ceil(encoded.length / CHARS_PER_TOKEN),
    );
  });

  it("prefers explicit fileSize over data URL measurement", () => {
    // fileSize is set, so the data URL should not be read.
    const dataUrl = `data:application/pdf;base64,${Buffer.from("x".repeat(1200)).toString("base64")}`;
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "doc.pdf",
            mediaType: "application/pdf",
            fileSize: 60_000,
            url: dataUrl,
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({ ...baseParams, messages });

    expect(tokensFor(breakdown, "files")).toBe(
      Math.ceil(60_000 / PDF_BYTES_PER_TOKEN),
    );
  });

  it("returns zero file tokens when there is no fileSize and no data URL", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        parts: [
          {
            type: "file",
            filename: "ref.pdf",
            mediaType: "application/pdf",
            url: "attachment://some-id",
          },
        ],
      },
    ];

    const breakdown = buildContextWindowBreakdown({ ...baseParams, messages });

    expect(tokensFor(breakdown, "files")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveInputPricePerToken
// ---------------------------------------------------------------------------

describe.skip("resolveInputPricePerToken", () => {
  it("returns null for a null model row", () => {
    expect(resolveInputPricePerToken(null)).toBeNull();
  });

  it("returns null when both price fields are null", () => {
    expect(
      resolveInputPricePerToken({
        promptPricePerToken: null,
        customPricePerMillionInput: null,
      }),
    ).toBeNull();
  });

  it("prefers customPricePerMillionInput over promptPricePerToken", () => {
    const result = resolveInputPricePerToken({
      customPricePerMillionInput: "3.0", // 3 USD/M → 0.000003/token
      promptPricePerToken: "0.000010", // would be 0.000010 if used
    });
    expect(result).toBeCloseTo(0.000003);
  });

  it("falls back to promptPricePerToken when custom price is absent", () => {
    const result = resolveInputPricePerToken({
      customPricePerMillionInput: null,
      promptPricePerToken: "0.000005",
    });
    expect(result).toBeCloseTo(0.000005);
  });

  it("ignores a non-positive customPricePerMillionInput and falls back", () => {
    const result = resolveInputPricePerToken({
      customPricePerMillionInput: "0",
      promptPricePerToken: "0.000005",
    });
    expect(result).toBeCloseTo(0.000005);
  });

  it("returns null when promptPricePerToken is zero", () => {
    expect(
      resolveInputPricePerToken({
        customPricePerMillionInput: null,
        promptPricePerToken: "0",
      }),
    ).toBeNull();
  });

  it("returns null when price strings are non-numeric", () => {
    expect(
      resolveInputPricePerToken({
        customPricePerMillionInput: "not-a-number",
        promptPricePerToken: "also-bad",
      }),
    ).toBeNull();
  });
});

// ============================================================================
// refreshBreakdownUsedTokens
// ============================================================================

describe.skip("refreshBreakdownUsedTokens", () => {
  const baseBreakdown = buildContextWindowBreakdown({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextLength: 200_000,
    inputPricePerToken: 0.000003,
    systemPrompt: "You are a helpful assistant.",
    messages: [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "Hello, world!" }],
      },
    ],
  });

  it("updates usedTokens to the provider-exact value", () => {
    const refreshed = refreshBreakdownUsedTokens(
      baseBreakdown,
      15_000,
      0.000003,
    );
    expect(refreshed.usedTokens).toBe(15_000);
  });

  it("recalculates freeTokens from the new usedTokens", () => {
    const refreshed = refreshBreakdownUsedTokens(
      baseBreakdown,
      15_000,
      0.000003,
    );
    // contextLength 200_000 - 15_000 = 185_000
    expect(refreshed.freeTokens).toBe(185_000);
  });

  it("recalculates usedPercent clamped to [0, 100]", () => {
    const refreshed = refreshBreakdownUsedTokens(
      baseBreakdown,
      15_000,
      0.000003,
    );
    expect(refreshed.usedPercent).toBeCloseTo(7.5);
  });

  it("clamps usedPercent to 100 when over context limit", () => {
    const refreshed = refreshBreakdownUsedTokens(
      baseBreakdown,
      250_000,
      0.000003,
    );
    expect(refreshed.usedPercent).toBe(100);
  });

  it("recalculates estimatedInputCostUsd with the new token count", () => {
    const refreshed = refreshBreakdownUsedTokens(
      baseBreakdown,
      10_000,
      0.000003,
    );
    expect(refreshed.estimatedInputCostUsd).toBeCloseTo(0.03);
  });

  it("sets estimatedInputCostUsd to null when no price provided", () => {
    const refreshed = refreshBreakdownUsedTokens(baseBreakdown, 10_000, null);
    expect(refreshed.estimatedInputCostUsd).toBeNull();
  });

  it("preserves provider, model, and contextLength unchanged", () => {
    const refreshed = refreshBreakdownUsedTokens(
      baseBreakdown,
      10_000,
      0.000003,
    );
    expect(refreshed.provider).toBe(baseBreakdown.provider);
    expect(refreshed.model).toBe(baseBreakdown.model);
    expect(refreshed.contextLength).toBe(baseBreakdown.contextLength);
  });

  it("scales segment tokens proportionally so they sum to approximately usedTokens", () => {
    const refreshed = refreshBreakdownUsedTokens(
      baseBreakdown,
      20_000,
      0.000003,
    );
    const segmentSum = refreshed.segments.reduce((sum, s) => sum + s.tokens, 0);
    // Scaled via rounding, sum should be close but may differ by a few tokens.
    expect(segmentSum).toBeGreaterThan(0);
    expect(Math.abs(segmentSum - 20_000)).toBeLessThanOrEqual(
      refreshed.segments.length,
    );
  });

  it("handles null contextLength gracefully", () => {
    const noContextBreakdown = buildContextWindowBreakdown({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextLength: null,
      messages: [
        {
          id: "m1",
          role: "user",
          parts: [{ type: "text", text: "Hello" }],
        },
      ],
    });
    const refreshed = refreshBreakdownUsedTokens(
      noContextBreakdown,
      5_000,
      null,
    );
    expect(refreshed.usedTokens).toBe(5_000);
    expect(refreshed.freeTokens).toBeNull();
    expect(refreshed.usedPercent).toBeNull();
  });
});
