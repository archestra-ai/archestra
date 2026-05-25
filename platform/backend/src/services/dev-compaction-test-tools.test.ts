import { describe, expect, test } from "vitest";
import {
  buildCompactionTestFacts,
  buildLargeOutputPayload,
  createDevCompactionTestTools,
} from "./dev-compaction-test-tools";

describe("dev compaction test tools", () => {
  test("returns no tools when disabled", () => {
    expect(
      createDevCompactionTestTools({
        toolConfig: { enabled: false, defaultPaddingChars: 1000 },
      }),
    ).toEqual({});
  });

  test("buildCompactionTestFacts is deterministic", () => {
    const first = buildCompactionTestFacts("scenario-a");
    const second = buildCompactionTestFacts("scenario-a");
    expect(second).toEqual(first);
    expect(first.compaction_fact).toMatch(/^COMPACTION-TEST-FACT-[A-F0-9]{8}$/);
    expect(first.compaction_issue).toMatch(/^PROJ-[A-F0-9]{6}$/);
    expect(first.compaction_url).toContain("scenario-a");
    expect(first.compaction_commit).toHaveLength(12);
  });

  test("large output payload embeds facts and exceeds default inline budget", () => {
    const facts = buildCompactionTestFacts("run-42");
    const payload = buildLargeOutputPayload({
      facts,
      paddingChars: 20_000,
      itemCount: 200,
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).toContain(facts.compaction_fact);
    expect(serialized).toContain(facts.compaction_issue);
    expect(serialized).toContain(facts.compaction_url);
    expect(payload.result_count).toBe(200);
    expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(20_000);
  });

  test("enabled registry exposes all dev compaction tools", () => {
    const tools = createDevCompactionTestTools({
      toolConfig: { enabled: true, defaultPaddingChars: DEFAULT_PADDING },
    });
    expect(Object.keys(tools).sort()).toEqual([
      "dev_compaction_large_output",
      "dev_compaction_ping",
      "dev_compaction_recall_facts",
    ]);
  });
});

const DEFAULT_PADDING = 50_000;
