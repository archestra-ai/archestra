import { describe, expect, it } from "vitest";
import reciprocalRankFusion from "./rrf";

interface Item {
  id: string;
  value: string;
}

const id = (item: Item) => item.id;

describe("reciprocalRankFusion", () => {
  it("ranks items appearing in both lists higher", () => {
    const vectorResults: Item[] = [
      { id: "a", value: "vector-a" },
      { id: "b", value: "vector-b" },
      { id: "c", value: "vector-c" },
    ];
    const fullTextResults: Item[] = [
      { id: "b", value: "ft-b" },
      { id: "d", value: "ft-d" },
      { id: "a", value: "ft-a" },
    ];

    const result = reciprocalRankFusion({
      rankings: [vectorResults, fullTextResults],
      idExtractor: id,
    });

    const ids = result.map((r) => r.id);
    // b and a appear in both lists, should rank highest
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("c"));
    expect(ids.indexOf("b")).toBeLessThan(ids.indexOf("d"));
    expect(result).toHaveLength(4);
  });

  it("preserves item data from the list that ranked it higher", () => {
    const list1: Item[] = [{ id: "a", value: "from-list1" }];
    const list2: Item[] = [
      { id: "x", value: "x" },
      { id: "a", value: "from-list2" },
    ];

    const result = reciprocalRankFusion({
      rankings: [list1, list2],
      idExtractor: id,
    });

    const itemA = result.find((r) => r.id === "a");
    // list1 ranked 'a' at position 1, list2 at position 2 → keep list1's data
    expect(itemA?.value).toBe("from-list1");
  });

  it("returns items in original order for a single list", () => {
    const items: Item[] = [
      { id: "a", value: "a" },
      { id: "b", value: "b" },
      { id: "c", value: "c" },
    ];

    const result = reciprocalRankFusion({
      rankings: [items],
      idExtractor: id,
    });

    expect(result.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("handles empty input", () => {
    const result = reciprocalRankFusion<Item>({
      rankings: [],
      idExtractor: id,
    });
    expect(result).toEqual([]);
  });

  it("handles one empty list among non-empty lists", () => {
    const items: Item[] = [
      { id: "a", value: "a" },
      { id: "b", value: "b" },
    ];

    const result = reciprocalRankFusion({
      rankings: [items, []],
      idExtractor: id,
    });

    expect(result.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("deduplicates by id", () => {
    const list1: Item[] = [
      { id: "a", value: "a" },
      { id: "b", value: "b" },
    ];
    const list2: Item[] = [
      { id: "a", value: "a2" },
      { id: "b", value: "b2" },
    ];

    const result = reciprocalRankFusion({
      rankings: [list1, list2],
      idExtractor: id,
    });

    expect(result).toHaveLength(2);
    const ids = result.map((r) => r.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
  });

  it("respects custom k parameter", () => {
    const list1: Item[] = [{ id: "a", value: "a" }];
    const list2: Item[] = [{ id: "b", value: "b" }];

    const resultK1 = reciprocalRankFusion({
      rankings: [list1, list2],
      idExtractor: id,
      k: 1,
    });

    const resultK1000 = reciprocalRankFusion({
      rankings: [list1, list2],
      idExtractor: id,
      k: 1000,
    });

    // With same single-occurrence items at rank 1, ordering is the same
    // but the scores differ. Both should return both items.
    expect(resultK1).toHaveLength(2);
    expect(resultK1000).toHaveLength(2);
  });

  it("applies weights to rank scores", () => {
    const list1: Item[] = [{ id: "a", value: "a" }];
    const list2: Item[] = [{ id: "b", value: "b" }];

    // Give list2 a much higher weight
    const result = reciprocalRankFusion({
      rankings: [list1, list2],
      idExtractor: id,
      weights: [1.0, 10.0],
    });

    // b should rank first because its list has 10x weight
    expect(result[0].id).toBe("b");
    expect(result[1].id).toBe("a");
  });

  it("is backward compatible without weights", () => {
    const list1: Item[] = [
      { id: "a", value: "a" },
      { id: "b", value: "b" },
    ];
    const list2: Item[] = [
      { id: "b", value: "b2" },
      { id: "c", value: "c" },
    ];

    const withWeights = reciprocalRankFusion({
      rankings: [list1, list2],
      idExtractor: id,
      weights: [1, 1],
    });

    const withoutWeights = reciprocalRankFusion({
      rankings: [list1, list2],
      idExtractor: id,
    });

    // Same ordering when weights are all 1
    expect(withWeights.map((r) => r.id)).toEqual(
      withoutWeights.map((r) => r.id),
    );
  });

  it("correctly weights keyword bias for BM25-heavy queries", () => {
    // Simulate: vector finds a, b; fulltext finds b, c
    // With weights [1.0, 4.0], fulltext items should rank higher
    const vectorResults: Item[] = [
      { id: "a", value: "vector-a" },
      { id: "b", value: "vector-b" },
    ];
    const fullTextResults: Item[] = [
      { id: "b", value: "ft-b" },
      { id: "c", value: "ft-c" },
    ];

    const result = reciprocalRankFusion({
      rankings: [vectorResults, fullTextResults],
      idExtractor: id,
      weights: [1.0, 4.0],
    });

    // b appears in both lists and gets boosted fulltext score → should be first
    expect(result[0].id).toBe("b");
    // c has fulltext weight 4.0 at rank 2 → score = 4/(50+2) = ~0.077
    // a has vector weight 1.0 at rank 1 → score = 1/(50+1) = ~0.0196
    expect(result[1].id).toBe("c");
    expect(result[2].id).toBe("a");
  });
});
