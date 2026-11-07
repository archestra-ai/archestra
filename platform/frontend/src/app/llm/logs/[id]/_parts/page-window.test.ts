// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mergedRecordsQuery } from "./page-window";
import { at, row } from "./test-records";

describe("mergedRecordsQuery", () => {
  // Pages are split by when requests finished. Page three's first request
  // started before page two's did: it ran long.
  const pageTwoFirst = row({
    id: "p2",
    createdAt: at(120_000),
    durationMs: 1_000,
  });
  const pageThreeFirst = row({
    id: "p3",
    createdAt: at(180_000),
    durationMs: 120_000,
  });
  const pages = [
    mergedRecordsQuery({ offset: 0, requests: [], nextRequest: pageTwoFirst }),
    mergedRecordsQuery({
      offset: 1,
      requests: [pageTwoFirst],
      nextRequest: pageThreeFirst,
    }),
    mergedRecordsQuery({
      offset: 2,
      requests: [pageThreeFirst],
      nextRequest: null,
    }),
  ];
  // The logs APIs keep createdAt >= startDate and createdAt <= endDate.
  const pagesWith = (createdAt: number) =>
    pages.flatMap((q, page) =>
      (!q.startDate || createdAt >= Date.parse(q.startDate)) &&
      (!q.endDate || createdAt <= Date.parse(q.endDate))
        ? [page]
        : [],
    );

  it("never runs backwards when requests overlap", () => {
    for (const q of pages) {
      if (q.startDate && q.endDate) {
        expect(Date.parse(q.startDate)).toBeLessThanOrEqual(
          Date.parse(q.endDate),
        );
      }
    }
  });

  it("puts each record on one page", () => {
    for (const seconds of [10, 60, 90, 119.5, 150, 200]) {
      expect(pagesWith(Date.parse(at(seconds * 1000)))).toHaveLength(1);
    }
  });
});
