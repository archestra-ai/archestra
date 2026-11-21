import { describe, expect, test } from "vitest";
import type { LogEvent, LogStatsQuery } from "@/types/log-events";
import { decodeFeedCursor, type LogFact, mergePages, summarize } from "./feed";

const TO = new Date("2026-10-14T12:30:00.000Z");
const FROM = new Date(TO.getTime() - 24 * 3_600_000);
const HOUR = 3_600_000;

describe("summarize", () => {
  test("sums fact counts, and a facet counts what every other filter keeps", () => {
    const facts = [
      fact({ source: "llm", status: "ok", count: 40 }),
      fact({ source: "llm", status: "error", count: 2 }),
      fact({ source: "mcp", status: "error", count: 5 }),
    ];

    const stats = run(facts, { sources: ["llm"], statuses: ["error"] });

    expect(stats.total).toBe(2);
    // The type picker still offers MCP: it counts errors of every type.
    expect(stats.facets.source).toEqual([
      { value: "mcp", count: 5 },
      { value: "llm", count: 2 },
    ]);
    // The status picker still offers OK: it counts every LLM request.
    expect(stats.facets.status).toEqual([
      { value: "ok", count: 40 },
      { value: "error", count: 2 },
    ]);
  });

  test("buckets the window by clock hour and counts errors and blocks", () => {
    const lastHour = Math.floor(TO.getTime() / HOUR) * HOUR;
    const facts = [
      fact({ hour: lastHour, status: "error", count: 3 }),
      fact({ hour: lastHour, source: "audit", status: "blocked", count: 1 }),
      fact({ hour: lastHour - 23 * HOUR, count: 7 }),
    ];

    const { buckets } = run(facts, {});

    // 24 hours from 12:30 touch 25 clock hours.
    expect(buckets).toHaveLength(25);
    expect(buckets.at(-1)).toMatchObject({
      bySource: { llm: 3, audit: 1 },
      errors: 4,
    });
    expect(buckets[1].bySource.llm).toBe(7);
  });

  test("a search filters only facts the database did not search", () => {
    const facts = [
      fact({ source: "llm", count: 9 }),
      fact({ source: "connections", count: 1, text: "cursor priya raman" }),
      fact({ source: "connections", count: 1, text: "codex marcus webb" }),
    ];

    expect(run(facts, { q: "priya" }).total).toBe(10);
  });
});

describe("mergePages", () => {
  test("pages through types newest first, each from its own position", () => {
    const pages = {
      llm: [event("llm", "a", 1), event("llm", "b", 3), event("llm", "c", 5)],
      audit: [event("audit", "x", 2), event("audit", "y", 4)],
    };

    const first = mergePages({ pages, cursor: {}, limit: 2 });
    expect(first.data.map((e) => e.id)).toEqual(["a", "x"]);
    const cursor = decodeFeedCursor(first.nextCursor ?? "");
    expect(cursor.llm).toEqual({ at: pages.llm[0].timestamp, id: "a" });
    expect(cursor.audit).toEqual({ at: pages.audit[0].timestamp, id: "x" });
  });

  test("a type that returned fewer rows than a page reads ends once shown", () => {
    const pages = {
      llm: [event("llm", "a", 1), event("llm", "b", 3), event("llm", "c", 5)],
      audit: [event("audit", "x", 2)],
    };

    const page = mergePages({ pages, cursor: {}, limit: 2 });

    expect(page.data.map((e) => e.id)).toEqual(["a", "x"]);
    expect(decodeFeedCursor(page.nextCursor ?? "").audit).toBe("end");
  });

  test("no cursor once every row read fits the page", () => {
    const page = mergePages({
      pages: { llm: [event("llm", "a", 1)] },
      cursor: {},
      limit: 2,
    });

    expect(page.nextCursor).toBeNull();
  });
});

function run(facts: LogFact[], query: Partial<LogStatsQuery>) {
  return summarize({
    facts,
    query: { sources: [], statuses: [], decision: [], hours: 24, ...query },
    from: FROM,
    to: TO,
    truncated: false,
  });
}

function fact(params: Partial<LogFact>): LogFact {
  return {
    source: "llm",
    hour: Math.floor(TO.getTime() / HOUR) * HOUR,
    status: "ok",
    count: 1,
    actor: { kind: "user", name: "Jordan" },
    ...params,
  };
}

function event(
  source: LogEvent["source"],
  id: string,
  minutesAgo: number,
): LogEvent {
  return {
    id,
    source,
    timestamp: new Date(TO.getTime() - minutesAgo * 60_000).toISOString(),
    status: "ok",
    title: id,
    actor: { kind: "user", name: "Jordan" },
    href: `/logs/${id}`,
  };
}
