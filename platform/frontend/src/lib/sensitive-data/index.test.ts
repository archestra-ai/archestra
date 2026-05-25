import { describe, expect, it } from "vitest";

import { entropyDetector } from "./entropy-detector";
import { defaultDetectors, scanText } from "./index";
import { regexDetector } from "./regex-detector";
import type { Detector, Finding } from "./types";
import { detectorId } from "./types";

const makeDetector = (id: string, scan: Detector["scan"]): Detector => ({
  id: detectorId(id),
  scan,
});

describe("scanText", () => {
  it("returns empty array for empty input with no detectors", () => {
    expect(scanText("")).toEqual([]);
  });

  it("returns empty array when default detectors find nothing", () => {
    expect(scanText("hello world", defaultDetectors)).toEqual([]);
  });

  it("aggregates findings across multiple detectors", () => {
    const a = makeDetector("a", () => [
      {
        detectorId: detectorId("a"),
        internalLabel: "x",
        startIndex: 0,
        endIndex: 3,
      },
    ]);
    const b = makeDetector("b", () => [
      {
        detectorId: detectorId("b"),
        internalLabel: "y",
        startIndex: 4,
        endIndex: 7,
      },
    ]);

    const result = scanText("some text", [a, b]);

    expect(result).toHaveLength(2);
    expect(result.map((f) => f.detectorId)).toEqual(["a", "b"]);
  });

  it("dedupes findings sharing detectorId + startIndex + endIndex", () => {
    const finding: Finding = {
      detectorId: detectorId("a"),
      internalLabel: "x",
      startIndex: 0,
      endIndex: 3,
    };
    const a = makeDetector("a", () => [finding, finding]);
    expect(scanText("abc", [a])).toEqual([finding]);
  });

  it("does not dedupe findings with different ranges from same detector", () => {
    const a = makeDetector("a", () => [
      {
        detectorId: detectorId("a"),
        internalLabel: "x",
        startIndex: 0,
        endIndex: 3,
      },
      {
        detectorId: detectorId("a"),
        internalLabel: "x",
        startIndex: 4,
        endIndex: 7,
      },
    ]);
    expect(scanText("abc def", [a])).toHaveLength(2);
  });

  it("threads existingFindings to subsequent detectors", () => {
    const a = makeDetector("a", () => [
      {
        detectorId: detectorId("a"),
        internalLabel: "x",
        startIndex: 0,
        endIndex: 3,
      },
    ]);

    let seenExisting: Finding[] | undefined;
    const b = makeDetector("b", (_text, ctx) => {
      seenExisting = ctx?.existingFindings.slice();
      return [];
    });

    scanText("hello", [a, b]);

    expect(seenExisting).toBeDefined();
    expect(seenExisting).toHaveLength(1);
    expect(seenExisting?.[0]?.detectorId).toBe("a");
  });

  it("passes an empty existingFindings to the first detector", () => {
    let seenExisting: Finding[] | undefined;
    const a = makeDetector("a", (_text, ctx) => {
      seenExisting = ctx?.existingFindings.slice();
      return [];
    });

    scanText("hello", [a]);

    expect(seenExisting).toEqual([]);
  });
});

describe("defaultDetectors", () => {
  it("contains regexDetector then entropyDetector", () => {
    expect(defaultDetectors).toHaveLength(2);
    expect(defaultDetectors[0]).toBe(regexDetector);
    expect(defaultDetectors[1]).toBe(entropyDetector);
  });
});
