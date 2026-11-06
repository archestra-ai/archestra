// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildRanOn, type SessionHandoffs } from "./ran-on";
import { buildTimeline, toolCallSpanKey } from "./session-timeline";
import { at, row, toolCall } from "./test-records";

const CLIENT = "client-session";
const RUN = "agent-run-1";
const RUN_ID = "3f9a2c1d-8e47-4b6a-a1f0-5c2d9e7b4a18";

const run = {
  runId: RUN_ID,
  llmSessionId: RUN,
  originLlmSessionId: CLIENT,
  agentName: "Platform Coder",
  title: "Fix the flaky test",
  startedAt: at(0),
};
const moves: SessionHandoffs["moves"] = [
  { kind: "push", runId: RUN_ID, mcpToolCallId: "push", at: at(10_000) },
  { kind: "pull", runId: RUN_ID, mcpToolCallId: "pull", at: at(40_000) },
  { kind: "steer", runId: RUN_ID, mcpToolCallId: "steer", at: at(60_000) },
];

const request = (id: string, seconds: number, sessionId: string) =>
  row({ id, sessionId, createdAt: at(seconds * 1000), durationMs: 1000 });
const move = (id: string, seconds: number) =>
  toolCall({ id, sessionId: CLIENT, createdAt: at(seconds * 1000) });

// The client's trace with the run's records merged in.
const timeline = buildTimeline({
  requests: [
    request("c1", 5, CLIENT),
    request("r1", 20, RUN),
    request("r2", 30, RUN),
    request("c2", 50, CLIENT),
    request("r3", 70, RUN),
  ],
  toolCalls: [move("push", 10), move("pull", 40), move("steer", 60)],
});

describe("buildRanOn", () => {
  it("splits the client's trace at each move and marks the run's rows", () => {
    const view = buildRanOn({
      timeline,
      handoffs: {
        handedTo: [run],
        handedToTruncated: false,
        handedFrom: null,
        moves,
      },
      sessionId: CLIENT,
    });
    expect(view?.side).toBe("client");
    expect(
      view?.segments.map((s) => [s.holder, s.requests, s.elsewhere]),
    ).toEqual([
      ["client", 1, false],
      ["runtime", 2, false],
      ["client", 1, false],
      ["runtime", 1, false],
    ]);
    expect(view?.moves.map((m) => m.kind)).toEqual(["push", "pull", "steer"]);
    expect([view?.clientRequests, view?.runtimeRequests]).toEqual([2, 3]);
    expect([...(view?.runtimeKeys ?? [])].sort()).toEqual([
      "request:r1",
      "request:r2",
      "request:r3",
    ]);
    // The lane opens on the first run row after a push or steer and closes on
    // the last one before the pull.
    expect(Object.fromEntries(view?.knobs ?? [])).toEqual({
      "request:r1": { kind: "push", edge: "top" },
      "request:r2": { kind: "pull", edge: "bottom" },
      "request:r3": { kind: "steer", edge: "top" },
    });
    // A move sits where its tool call ended.
    const push = timeline?.spans.find((s) => s.key === toolCallSpanKey("push"));
    expect(view?.moves[0].x).toBeCloseTo((push?.x ?? 0) + (push?.w ?? 0));
  });

  it("shows the client's stretch on the run's own trace as a placeholder", () => {
    const runTimeline = buildTimeline({
      requests: [
        request("r1", 20, RUN),
        request("r2", 30, RUN),
        request("r3", 70, RUN),
      ],
    });
    const view = buildRanOn({
      timeline: runTimeline,
      handoffs: {
        handedTo: [],
        handedToTruncated: false,
        handedFrom: run,
        moves,
      },
      sessionId: RUN,
    });
    expect(view?.side).toBe("runtime");
    expect(
      view?.segments.map((s) => [s.holder, s.requests, s.elsewhere]),
    ).toEqual([
      ["runtime", 2, false],
      ["client", 0, true],
      ["runtime", 1, false],
    ]);
    expect(view?.runtimeRequests).toBe(3);
  });

  it("starts the run's stretch at its first request when no move is readable", () => {
    const view = buildRanOn({
      timeline,
      handoffs: {
        handedTo: [run],
        handedToTruncated: false,
        handedFrom: null,
        moves: [],
      },
      sessionId: CLIENT,
    });
    expect(view?.segments.map((s) => s.holder)).toEqual(["client", "runtime"]);
    expect(view?.moves.map((m) => m.kind)).toEqual(["push"]);
  });

  it("ties each runtime stretch and move to its own run", () => {
    const second = {
      ...run,
      runId: "9b1e0f6a-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
      llmSessionId: "agent-run-2",
      agentName: "Docs Writer",
    };
    const twoRuns = buildTimeline({
      requests: [
        request("c1", 5, CLIENT),
        request("a1", 20, RUN),
        request("c2", 50, CLIENT),
        request("b1", 70, "agent-run-2"),
      ],
      toolCalls: [move("push", 10), move("pull", 40), move("push-b", 60)],
    });
    const view = buildRanOn({
      timeline: twoRuns,
      handoffs: {
        handedTo: [run, second],
        handedToTruncated: false,
        handedFrom: null,
        moves: [
          moves[0],
          moves[1],
          {
            kind: "push",
            runId: second.runId,
            mcpToolCallId: "push-b",
            at: at(60_000),
          },
        ],
      },
      sessionId: CLIENT,
    });
    expect(view?.segments.map((s) => [s.runIds, s.requests])).toEqual([
      [[], 1],
      [[RUN_ID], 1],
      [[], 1],
      [[second.runId], 1],
    ]);
    expect(view?.moves.map((m) => m.runId)).toEqual([
      RUN_ID,
      RUN_ID,
      second.runId,
    ]);
  });

  it("keeps overlapping runs on the strip until each is taken back", () => {
    const second = { ...run, runId: "run-b", llmSessionId: "agent-run-2" };
    const overlap = buildTimeline({
      requests: [
        request("c1", 5, CLIENT),
        request("a1", 15, RUN),
        request("a2", 25, RUN),
        request("b1", 26, "agent-run-2"),
        request("b2", 35, "agent-run-2"),
        request("c2", 50, CLIENT),
      ],
      toolCalls: [
        move("push-a", 10),
        move("push-b", 20),
        move("pull-a", 30),
        move("pull-b", 40),
      ],
    });
    const mv = (
      kind: "push" | "pull",
      runId: string,
      id: string,
      s: number,
    ) => ({
      kind,
      runId,
      mcpToolCallId: id,
      at: at(s * 1000),
    });
    const view = buildRanOn({
      timeline: overlap,
      handoffs: {
        handedTo: [run, second],
        handedToTruncated: false,
        handedFrom: null,
        moves: [
          mv("push", RUN_ID, "push-a", 10),
          mv("push", "run-b", "push-b", 20),
          mv("pull", RUN_ID, "pull-a", 30),
          mv("pull", "run-b", "pull-b", 40),
        ],
      },
      sessionId: CLIENT,
    });
    expect(view?.segments.map((s) => [s.holder, s.runIds, s.requests])).toEqual(
      [
        ["client", [], 1],
        ["runtime", [RUN_ID], 1],
        ["runtime", [RUN_ID, "run-b"], 2],
        ["runtime", ["run-b"], 1],
        ["client", [], 1],
      ],
    );
  });

  it("ends a run's own strip at a final pull without a client placeholder", () => {
    const runTimeline = buildTimeline({
      requests: [request("r1", 20, RUN), request("r2", 30, RUN)],
    });
    const view = buildRanOn({
      timeline: runTimeline,
      handoffs: {
        handedTo: [],
        handedToTruncated: false,
        handedFrom: run,
        moves: moves.slice(0, 2),
      },
      sessionId: RUN,
    });
    expect(view?.segments.map((s) => s.holder)).toEqual(["runtime"]);
    expect(view?.moves.map((m) => [m.kind, m.x])).toEqual([
      ["push", 0],
      ["pull", 1],
    ]);
  });

  it("is null for a session that handed nothing off", () => {
    expect(
      buildRanOn({
        timeline,
        handoffs: {
          handedTo: [],
          handedToTruncated: false,
          handedFrom: null,
          moves: [],
        },
        sessionId: CLIENT,
      }),
    ).toBeNull();
  });
});
