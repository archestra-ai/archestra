import { describe, expect, test } from "vitest";
import type { LogEvent, LogEventsQuery } from "@/types/log-events";
import { queryFeed } from "./feed";

const TO = new Date("2026-10-14T12:00:00.000Z");
const FROM = new Date(TO.getTime() - 24 * 3_600_000);

describe("queryFeed", () => {
  test("pages the newest events first, and the cursor continues where the page stopped", () => {
    const events = [
      event({ id: "a", minutesAgo: 30 }),
      event({ id: "b", minutesAgo: 10 }),
      event({ id: "c", minutesAgo: 20 }),
    ];

    const first = run(events, { limit: 2 });
    expect(first.data.map((e) => e.id)).toEqual(["b", "c"]);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toBe("2");

    const second = run(events, { limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.data.map((e) => e.id)).toEqual(["a"]);
    expect(second.nextCursor).toBeNull();
  });

  test("a facet counts what every other filter keeps, ignoring its own", () => {
    const events = [
      event({ id: "1", source: "llm", status: "ok" }),
      event({ id: "2", source: "llm", status: "error" }),
      event({ id: "3", source: "mcp", status: "error" }),
    ];

    const result = run(events, { sources: ["llm"], statuses: ["error"] });

    expect(result.data.map((e) => e.id)).toEqual(["2"]);
    // The type picker still offers MCP: it counts errors of every type.
    expect(result.facets.source).toEqual([
      { value: "llm", count: 1 },
      { value: "mcp", count: 1 },
    ]);
    // The status picker still offers OK: it counts every LLM event.
    expect(result.facets.status).toEqual([
      { value: "error", count: 1 },
      { value: "ok", count: 1 },
    ]);
  });

  test("search matches any shown field, ignoring case", () => {
    const events = [
      event({ id: "1", title: "claude-sonnet-4-6" }),
      event({ id: "2", title: "gpt-5.4", actorName: "Priya Raman" }),
    ];

    expect(run(events, { q: "PRIYA" }).data.map((e) => e.id)).toEqual(["2"]);
  });

  test("buckets split the window into 48 and count errors and blocks", () => {
    const events = [
      event({ id: "1", minutesAgo: 1, status: "error" }),
      event({ id: "2", minutesAgo: 2, status: "blocked", source: "audit" }),
      event({ id: "3", minutesAgo: 23 * 60 + 50 }),
    ];

    const { buckets } = run(events, {});

    expect(buckets).toHaveLength(48);
    expect(buckets[0].bySource.llm).toBe(1);
    expect(buckets[47]).toMatchObject({
      bySource: { llm: 1, audit: 1 },
      errors: 2,
    });
  });
});

function run(events: LogEvent[], query: Partial<LogEventsQuery>) {
  return queryFeed({
    events,
    query: {
      sources: [],
      statuses: [],
      decision: [],
      hours: 24,
      limit: 100,
      ...query,
    },
    from: FROM,
    to: TO,
    truncated: false,
  });
}

function event(params: {
  id: string;
  minutesAgo?: number;
  source?: LogEvent["source"];
  status?: LogEvent["status"];
  title?: string;
  actorName?: string;
}): LogEvent {
  return {
    id: params.id,
    source: params.source ?? "llm",
    timestamp: new Date(
      TO.getTime() - (params.minutesAgo ?? 5) * 60_000,
    ).toISOString(),
    status: params.status ?? "ok",
    title: params.title ?? "event",
    actor: { kind: "user", name: params.actorName ?? "Jordan" },
    href: `/logs/${params.id}`,
  };
}
