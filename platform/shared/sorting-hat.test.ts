import { describe, expect, test } from "vitest";
import {
  getSortingHatMeta,
  SORTING_HAT_META_KEY,
  type SortingHatMeta,
} from "./sorting-hat";

describe("getSortingHatMeta", () => {
  test("parses valid sorting metadata", () => {
    const meta: SortingHatMeta = {
      house: "gryffindor",
      confidence: 0.84,
      monologue: ["A daring call", "with sparks in flight"],
      patronus: { form: "stag", corporeal: true },
    };

    expect(
      getSortingHatMeta({
        _meta: {
          [SORTING_HAT_META_KEY]: meta,
        },
      }),
    ).toEqual(meta);
  });

  test("returns null for unknown houses", () => {
    expect(
      getSortingHatMeta({
        _meta: {
          [SORTING_HAT_META_KEY]: { house: "beauxbatons", confidence: 1 },
        },
      }),
    ).toBeNull();
  });
});
