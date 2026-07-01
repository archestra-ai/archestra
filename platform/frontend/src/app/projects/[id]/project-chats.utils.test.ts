import { describe, expect, it } from "vitest";
import {
  collapseProjectChats,
  countRunsByTrigger,
  formatScheduledRecentRow,
} from "./project-chats.utils";

type TestChat = {
  id: string;
  origin: "user" | "schedule_trigger";
  lastMessageAt: string;
  scheduleTriggerId: string | null;
};

const item = (over: Partial<TestChat>): TestChat => ({
  id: "x",
  origin: "user",
  lastMessageAt: "2026-01-01T00:00:00Z",
  scheduleTriggerId: null,
  ...over,
});

describe("collapseProjectChats", () => {
  it("keeps every user chat", () => {
    const out = collapseProjectChats([item({ id: "u1" }), item({ id: "u2" })]);
    expect(out.map((c) => c.id).sort()).toEqual(["u1", "u2"]);
  });

  it("collapses a schedule's runs to the single latest run", () => {
    const out = collapseProjectChats([
      item({
        id: "r1",
        origin: "schedule_trigger",
        scheduleTriggerId: "t1",
        lastMessageAt: "2026-01-01T10:00:00Z",
      }),
      item({
        id: "r2",
        origin: "schedule_trigger",
        scheduleTriggerId: "t1",
        lastMessageAt: "2026-01-01T12:00:00Z",
      }),
      item({
        id: "r3",
        origin: "schedule_trigger",
        scheduleTriggerId: "t1",
        lastMessageAt: "2026-01-01T08:00:00Z",
      }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("r2"); // the latest run by lastMessageAt
  });

  it("keeps one row per distinct schedule", () => {
    const out = collapseProjectChats([
      item({
        id: "a",
        origin: "schedule_trigger",
        scheduleTriggerId: "t1",
        lastMessageAt: "2026-01-01T01:00:00Z",
      }),
      item({
        id: "b",
        origin: "schedule_trigger",
        scheduleTriggerId: "t2",
        lastMessageAt: "2026-01-01T02:00:00Z",
      }),
    ]);
    expect(out.map((c) => c.id)).toEqual(["b", "a"]); // newest activity first
  });

  it("merges user and collapsed scheduled chats, newest activity first", () => {
    const out = collapseProjectChats([
      item({ id: "u", origin: "user", lastMessageAt: "2026-01-01T05:00:00Z" }),
      item({
        id: "r1",
        origin: "schedule_trigger",
        scheduleTriggerId: "t1",
        lastMessageAt: "2026-01-01T03:00:00Z",
      }),
      item({
        id: "r2",
        origin: "schedule_trigger",
        scheduleTriggerId: "t1",
        lastMessageAt: "2026-01-01T09:00:00Z",
      }),
    ]);
    expect(out.map((c) => c.id)).toEqual(["r2", "u"]); // r2 (09:00) then u (05:00)
  });

  it("falls back to showing a scheduled chat individually when it has no schedule id", () => {
    const out = collapseProjectChats([
      item({
        id: "x1",
        origin: "schedule_trigger",
        scheduleTriggerId: null,
        lastMessageAt: "2026-01-01T01:00:00Z",
      }),
      item({
        id: "x2",
        origin: "schedule_trigger",
        scheduleTriggerId: null,
        lastMessageAt: "2026-01-01T02:00:00Z",
      }),
    ]);
    expect(out.map((c) => c.id)).toEqual(["x2", "x1"]); // not collapsed together
  });
});

describe("countRunsByTrigger", () => {
  it("counts a schedule's runs and ignores user chats", () => {
    const counts = countRunsByTrigger([
      item({ id: "u1", origin: "user" }),
      item({ id: "r1", origin: "schedule_trigger", scheduleTriggerId: "t1" }),
      item({ id: "r2", origin: "schedule_trigger", scheduleTriggerId: "t1" }),
      item({ id: "r3", origin: "schedule_trigger", scheduleTriggerId: "t2" }),
    ]);
    expect(counts.get("t1")).toBe(2);
    expect(counts.get("t2")).toBe(1);
    expect(counts.size).toBe(2); // user chat contributes no key
  });

  it("ignores scheduled chats with no schedule id", () => {
    const counts = countRunsByTrigger([
      item({ id: "x", origin: "schedule_trigger", scheduleTriggerId: null }),
    ]);
    expect(counts.size).toBe(0);
  });
});

describe("formatScheduledRecentRow", () => {
  it("prefixes the schedule name and pluralizes the run count", () => {
    expect(
      formatScheduledRecentRow({
        scheduleName: "Weekly summary",
        prompt: "Generate the report",
        runCount: 12,
      }),
    ).toEqual({
      title: "Scheduled task · Weekly summary",
      meta: "12 runs · Generate the report",
    });
  });

  it("uses the singular 'run' for a single run", () => {
    expect(
      formatScheduledRecentRow({
        scheduleName: "Daily",
        prompt: "do it",
        runCount: 1,
      }).meta,
    ).toBe("1 run · do it");
  });

  it("falls back when the schedule name or prompt is missing", () => {
    expect(
      formatScheduledRecentRow({
        scheduleName: null,
        prompt: null,
        runCount: 0,
      }),
    ).toEqual({ title: "Scheduled task", meta: "0 runs · No prompt" });
  });
});
