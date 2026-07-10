import { toonEncodeToolResults as nativeToonEncodeToolResults } from "@archestra/proxy-transform-rs";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { metrics } from "@/observability";
import { convertToolResultsToToon } from "../adapters/openai";
import { toonEncodeToolResults } from "./toon-native";

// The native transform is a compiled addon that may be absent in the unit-test
// env; mock it at the boundary to pin the helper's wiring only. Real encoding
// is covered by toon-native.golden.test.ts and the Rust crate tests.
vi.mock("@archestra/proxy-transform-rs", () => ({
  toonEncodeToolResults: vi.fn(),
}));
vi.mock("@/observability");

const items = [
  { id: "call_1", rawContent: '{"a":[1,2]}', unwrap: true },
  { id: "call_2", rawContent: "not json", unwrap: true },
];

describe("toonEncodeToolResults helper", () => {
  beforeEach(() => {
    vi.mocked(nativeToonEncodeToolResults).mockReset();
  });

  test("returns the positional native results on success", async () => {
    const nativeResults = [
      { normalized: '{"a":[1,2]}', encoded: "a[2]: 1,2" },
      { normalized: "not json", encoded: null },
    ];
    vi.mocked(nativeToonEncodeToolResults).mockResolvedValue(nativeResults);

    const results = await toonEncodeToolResults(items);

    expect(results).toStrictEqual(nativeResults);
    expect(nativeToonEncodeToolResults).toHaveBeenCalledWith(items);
    expect(metrics.llm.reportToonAddonUnavailable).not.toHaveBeenCalled();
  });

  test("returns null when the native batch length does not match the input", async () => {
    vi.mocked(nativeToonEncodeToolResults).mockResolvedValue([
      { normalized: '{"a":[1,2]}', encoded: "a[2]: 1,2" },
    ]);

    const results = await toonEncodeToolResults(items);

    expect(results).toBeNull();
    expect(metrics.llm.reportToonAddonUnavailable).toHaveBeenCalledWith(
      "request",
    );
  });

  test("returns null (fail-open) when the native call fails", async () => {
    vi.mocked(nativeToonEncodeToolResults).mockRejectedValue(
      new Error("addon missing"),
    );

    const results = await toonEncodeToolResults(items);

    expect(results).toBeNull();
    expect(metrics.llm.reportToonAddonUnavailable).toHaveBeenCalledWith(
      "request",
    );
  });
});

describe("convertToolResultsToToon with the addon unavailable", () => {
  beforeEach(() => {
    vi.mocked(nativeToonEncodeToolResults).mockReset();
    vi.mocked(nativeToonEncodeToolResults).mockRejectedValue(
      new Error("addon missing"),
    );
  });

  test("fails open: messages untouched, explicit addon_unavailable skip reason", async () => {
    const messages = [
      { role: "user" as const, content: "list files" },
      {
        role: "tool" as const,
        tool_call_id: "call_1",
        content: '{"files":[{"name":"a"},{"name":"b"}]}',
      },
    ];

    const { messages: resultMessages, stats } = await convertToolResultsToToon(
      messages,
      "gpt-4o",
      "openai",
    );

    expect(resultMessages).toStrictEqual(messages);
    expect(stats).toStrictEqual({
      tokensBefore: 0,
      tokensAfter: 0,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: true,
      skipReason: "addon_unavailable",
    });
  });

  test("does not call the native addon when there are no tool results", async () => {
    const messages = [{ role: "user" as const, content: "hello" }];

    const { messages: resultMessages, stats } = await convertToolResultsToToon(
      messages,
      "gpt-4o",
      "openai",
    );

    expect(resultMessages).toStrictEqual(messages);
    expect(stats).toStrictEqual({
      tokensBefore: 0,
      tokensAfter: 0,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: false,
    });
    expect(nativeToonEncodeToolResults).not.toHaveBeenCalled();
  });
});
