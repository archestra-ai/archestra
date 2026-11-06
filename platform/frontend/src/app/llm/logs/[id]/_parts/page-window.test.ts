// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pageWindow, windowQuery } from "./page-window";
import { at, row } from "./test-records";

describe("pageWindow", () => {
  // Page two opens with a request that ran from 60s to 120s.
  const boundary = row({ id: "b", createdAt: at(120_000), durationMs: 60_000 });
  const pageOne = pageWindow({
    offset: 0,
    requests: [row({ id: "a", createdAt: at(10_000) })],
    nextRequest: boundary,
    hasNextPage: true,
  });
  const pageTwo = pageWindow({
    offset: 1,
    requests: [boundary],
    nextRequest: null,
    hasNextPage: false,
  });

  it("shares one boundary between adjacent pages", () => {
    expect(pageOne.endsAt).toBe(pageTwo.startsAt);
    expect(pageOne.startsAt).toBeNull();
    expect(pageTwo.endsAt).toBeNull();
  });

  it("puts a record made while the boundary request ran on a page", () => {
    const madeAt = Date.parse(at(90_000));
    const onPage = (w: { startsAt: number | null; endsAt: number | null }) =>
      (w.startsAt === null || madeAt >= w.startsAt) &&
      (w.endsAt === null || madeAt < w.endsAt);
    expect([onPage(pageOne), onPage(pageTwo)]).toEqual([false, true]);
  });

  it("asks the inclusive logs APIs for each boundary record once", () => {
    // The APIs keep createdAt >= startDate and createdAt <= endDate.
    const madeAt = pageOne.endsAt ?? 0;
    const fetchedBy = (q: { startDate?: string; endDate?: string }) =>
      (!q.startDate || madeAt >= Date.parse(q.startDate)) &&
      (!q.endDate || madeAt <= Date.parse(q.endDate));
    expect([
      fetchedBy(windowQuery(pageOne)),
      fetchedBy(windowQuery(pageTwo)),
    ]).toEqual([false, true]);
  });
});
