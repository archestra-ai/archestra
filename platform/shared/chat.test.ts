import { describe, expect, test } from "vitest";
import {
  CONTEXT_WINDOW_BREAKDOWN_EVENT,
  CONTEXT_WINDOW_CATEGORIES,
  ContextWindowBreakdownSchema,
  getAcceptedFileTypes,
  getMediaType,
  getSupportedFileTypesDescription,
  hasPersistableAssistantContent,
  hasRenderableAssistantContent,
  INPUT_MODALITY_OPTIONS,
  OUTPUT_MODALITY_OPTIONS,
  supportsFileUploads,
} from "./chat";

const VALID_BREAKDOWN = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  contextLength: 200_000,
  usedTokens: 84_200,
  freeTokens: 115_800,
  usedPercent: 42.1,
  estimatedInputCostUsd: 0.04,
  segments: [
    { category: "system_prompt", tokens: 2100, items: [] },
    { category: "tools", tokens: 31_400 },
    { category: "messages", tokens: 18_700 },
    { category: "tool_results", tokens: 30_000 },
    { category: "files", tokens: 2000 },
  ],
} as const;

describe.skip("ContextWindowBreakdownSchema", () => {
  test("parses a valid breakdown", () => {
    expect(
      ContextWindowBreakdownSchema.safeParse(VALID_BREAKDOWN).success,
    ).toBe(true);
  });

  test("allows null contextLength, freeTokens, usedPercent, and estimatedInputCostUsd", () => {
    const result = ContextWindowBreakdownSchema.safeParse({
      ...VALID_BREAKDOWN,
      contextLength: null,
      freeTokens: null,
      usedPercent: null,
      estimatedInputCostUsd: null,
    });
    expect(result.success).toBe(true);
  });

  test("rejects negative usedTokens", () => {
    expect(
      ContextWindowBreakdownSchema.safeParse({
        ...VALID_BREAKDOWN,
        usedTokens: -1,
      }).success,
    ).toBe(false);
  });

  test("rejects missing required fields", () => {
    const { provider: _omit, ...withoutProvider } = VALID_BREAKDOWN;
    expect(
      ContextWindowBreakdownSchema.safeParse(withoutProvider).success,
    ).toBe(false);
  });

  test("rejects unknown category in a segment", () => {
    expect(
      ContextWindowBreakdownSchema.safeParse({
        ...VALID_BREAKDOWN,
        segments: [{ category: "unknown_category", tokens: 100 }],
      }).success,
    ).toBe(false);
  });

  test("rejects usedPercent below 0", () => {
    expect(
      ContextWindowBreakdownSchema.safeParse({
        ...VALID_BREAKDOWN,
        usedPercent: -1,
      }).success,
    ).toBe(false);
  });

  test("rejects usedPercent above 100", () => {
    expect(
      ContextWindowBreakdownSchema.safeParse({
        ...VALID_BREAKDOWN,
        usedPercent: 101,
      }).success,
    ).toBe(false);
  });

  test("accepts usedPercent at boundary values 0 and 100", () => {
    expect(
      ContextWindowBreakdownSchema.safeParse({
        ...VALID_BREAKDOWN,
        usedPercent: 0,
      }).success,
    ).toBe(true);
    expect(
      ContextWindowBreakdownSchema.safeParse({
        ...VALID_BREAKDOWN,
        usedPercent: 100,
      }).success,
    ).toBe(true);
  });

  test("rejects negative segment token counts", () => {
    expect(
      ContextWindowBreakdownSchema.safeParse({
        ...VALID_BREAKDOWN,
        segments: [{ category: "messages", tokens: -5 }],
      }).success,
    ).toBe(false);
  });

  test("allows segments with no items array", () => {
    const result = ContextWindowBreakdownSchema.safeParse({
      ...VALID_BREAKDOWN,
      segments: [{ category: "messages", tokens: 100 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.segments[0].items).toBeUndefined();
    }
  });
});

describe.skip("CONTEXT_WINDOW_BREAKDOWN_EVENT", () => {
  test("is the canonical event name string", () => {
    expect(CONTEXT_WINDOW_BREAKDOWN_EVENT).toBe(
      "data-context-window-breakdown",
    );
  });
});

describe.skip("CONTEXT_WINDOW_CATEGORIES", () => {
  test("is in canonical stack order", () => {
    expect(CONTEXT_WINDOW_CATEGORIES).toEqual([
      "system_prompt",
      "tools",
      "messages",
      "tool_results",
      "files",
    ]);
  });
});

describe.skip("chat file upload helpers", () => {
  test("treats text modality as supporting txt, md, csv, and json uploads", () => {
    expect(getAcceptedFileTypes(["text"])).toBe(
      [
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/csv",
        "application/vnd.ms-excel",
        "application/json",
      ].join(","),
    );
    expect(supportsFileUploads(["text"])).toBe(true);
    expect(getSupportedFileTypesDescription(["text"])).toBe(
      "chat prompts, .txt, .csv, .md, and .json uploads",
    );
  });

  test("deduplicates mime types across modalities", () => {
    expect(getAcceptedFileTypes(["text", "text", "pdf"])).toBe(
      [
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/csv",
        "application/vnd.ms-excel",
        "application/json",
        "application/pdf",
      ].join(","),
    );
  });

  test("returns no file types when modalities are missing", () => {
    expect(getAcceptedFileTypes(null)).toBeUndefined();
    expect(getAcceptedFileTypes(undefined)).toBeUndefined();
    expect(getAcceptedFileTypes([])).toBeUndefined();
    expect(supportsFileUploads(null)).toBe(false);
    expect(getSupportedFileTypesDescription(undefined)).toBeNull();
  });

  test("builds a readable description for multiple upload modalities", () => {
    expect(
      getSupportedFileTypesDescription(["text", "image", "pdf", "audio"]),
    ).toBe(
      "chat prompts, .txt, .csv, .md, and .json uploads, images, PDFs, audio",
    );
  });

  test("uses explicit file media types when present", () => {
    expect(getMediaType({ name: "notes.txt", type: "text/markdown" })).toBe(
      "text/markdown",
    );
  });

  test("falls back to extension-based media type detection", () => {
    expect(getMediaType({ name: "report.pdf", type: "" })).toBe(
      "application/pdf",
    );
    expect(getMediaType({ name: "table.csv", type: "" })).toBe("text/csv");
    expect(getMediaType({ name: "README.md", type: "" })).toBe("text/markdown");
    expect(getMediaType({ name: "readme.txt", type: "" })).toBe("text/plain");
  });

  test("defaults unknown extensions to application/octet-stream", () => {
    expect(getMediaType({ name: "archive.bin", type: "" })).toBe(
      "application/octet-stream",
    );
    expect(getMediaType({ name: "no-extension", type: "" })).toBe(
      "application/octet-stream",
    );
  });

  test("exports exhaustive input and output modality option metadata", () => {
    expect(INPUT_MODALITY_OPTIONS.map((option) => option.value)).toEqual([
      "text",
      "image",
      "audio",
      "video",
      "pdf",
    ]);
    expect(OUTPUT_MODALITY_OPTIONS.map((option) => option.value)).toEqual([
      "text",
      "image",
      "audio",
    ]);
  });
});

describe.skip("hasPersistableAssistantContent", () => {
  test("keeps assistant turns carrying renderable content", () => {
    expect(
      hasPersistableAssistantContent({
        parts: [{ type: "text", text: "hello" }],
      }),
    ).toBe(true);
  });

  test("drops empty turns", () => {
    expect(hasPersistableAssistantContent({})).toBe(false);
    expect(hasPersistableAssistantContent({ parts: [] })).toBe(false);
    expect(
      hasPersistableAssistantContent({ parts: [{ type: "text", text: "  " }] }),
    ).toBe(false);
  });

  // read-path callers pass historical JSON that is only cast, so malformed
  // rows must be treated as empty rather than throwing and failing the load.
  test("tolerates malformed persisted parts without throwing", () => {
    const malformed = [
      { parts: {} },
      { parts: [{}] },
      { parts: [null] },
      { parts: [{ type: 42 }] },
      { parts: "not-an-array" },
    ];
    for (const message of malformed) {
      expect(
        hasPersistableAssistantContent(
          message as Parameters<typeof hasPersistableAssistantContent>[0],
        ),
      ).toBe(false);
    }
  });
});

describe.skip("hasRenderableAssistantContent", () => {
  test("returns true when a non-empty text part is present", () => {
    expect(
      hasRenderableAssistantContent({ parts: [{ type: "text", text: "hi" }] }),
    ).toBe(true);
  });

  test("returns false for an empty text part alone", () => {
    expect(
      hasRenderableAssistantContent({ parts: [{ type: "text", text: "" }] }),
    ).toBe(false);
  });

  test("returns false for a breakdown-only assistant turn", () => {
    // data-context-window-breakdown must be in NON_RENDERABLE so a turn that
    // contains only that telemetry part does not produce an empty assistant bubble.
    expect(
      hasRenderableAssistantContent({
        parts: [{ type: "data-context-window-breakdown" }],
      }),
    ).toBe(false);
  });

  test("returns false when all parts are non-renderable telemetry", () => {
    expect(
      hasRenderableAssistantContent({
        parts: [
          { type: "step-start" },
          { type: "data-token-usage" },
          { type: "data-context-window-breakdown" },
          { type: "data-context-window-estimate" },
        ],
      }),
    ).toBe(false);
  });

  test("returns true when a renderable part accompanies telemetry parts", () => {
    expect(
      hasRenderableAssistantContent({
        parts: [
          { type: "data-context-window-breakdown" },
          { type: "text", text: "Here is the answer." },
        ],
      }),
    ).toBe(true);
  });

  test("returns false for no parts", () => {
    expect(hasRenderableAssistantContent({ parts: [] })).toBe(false);
    expect(hasRenderableAssistantContent({})).toBe(false);
  });
});
