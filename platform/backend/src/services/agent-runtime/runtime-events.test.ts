import {
  type AgentRuntimeEvent,
  type AgentRuntimeState,
  agentRuntimeError,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { AgentRuntimeEventMonitor } from "./runtime-events";

const taskId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";

function event(
  sequence: number,
  payload: Partial<AgentRuntimeEvent> & { type: AgentRuntimeEvent["type"] },
): AgentRuntimeEvent {
  const base = {
    version: 1 as const,
    eventId: `33333333-3333-4333-8333-${String(sequence).padStart(12, "0")}`,
    taskId,
    attemptId,
    sequence,
    source: "test",
    observedAt: "2026-09-17T12:00:00.000Z",
  };
  return { ...base, ...payload } as AgentRuntimeEvent;
}

function response(events: AgentRuntimeEvent[], hasMore = false): string {
  return JSON.stringify({
    version: 1,
    taskId,
    attemptId,
    events,
    nextSequence: events.at(-1)?.sequence ?? 0,
    hasMore,
  });
}

describe("AgentRuntimeEventMonitor", () => {
  test("drains a full journal before closing the run", async () => {
    const failure = agentRuntimeError("runtime_restarted");
    const events = Array.from({ length: 999 }, (_, index) =>
      event(index + 1, {
        type: "agent.status",
        status: "working",
        attention: null,
      }),
    );
    events.push(
      event(1000, { type: "turn.finished", outcome: "failed", error: failure }),
    );
    const monitor = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      read: async ({ afterSequence }) =>
        response(
          events.slice(afterSequence, afterSequence + 100),
          afterSequence + 100 < events.length,
        ),
      persist: async () => true,
    });
    await expect(monitor.poll()).resolves.toMatchObject({
      accepted: 1000,
      hasMore: false,
    });
    expect(monitor.latestFailure).toEqual(failure);
  });

  test("recovers a terminal diagnostic after backend restart and later advisory events", async () => {
    let state: AgentRuntimeState | null = null;
    const failure = agentRuntimeError("runtime_restarted");
    const monitor = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      read: async () =>
        response([
          event(1, {
            type: "turn.finished",
            outcome: "failed",
            error: failure,
          }),
        ]),
      persist: async (value) => {
        state = value.state;
        return true;
      },
    });
    await monitor.poll();
    const recovered = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      initialState: state,
      read: async () =>
        response([
          event(2, {
            type: "agent.status",
            status: "working",
            attention: null,
            source: "herdr",
          }),
        ]),
      persist: async (value) => {
        state = value.state;
        return true;
      },
    });
    await recovered.poll();
    expect(recovered.failureReasonForExit()).toContain(failure.resolution);
    expect(state).toMatchObject({ outcome: "failed", diagnostic: failure });
  });

  test("persists status and typed diagnostics without settling a task", async () => {
    const states: Array<{
      state: unknown;
      attentionState: unknown;
    }> = [];
    const events = [
      event(1, {
        type: "agent.status",
        status: "working",
        attention: null,
      }),
      event(2, {
        type: "diagnostic",
        error: {
          code: "provider_auth_required",
          phase: "credentials",
          message: "Reconnect the provider.",
          resolution: "Reconnect the provider account, then retry.",
        },
      }),
      event(3, {
        type: "turn.finished",
        outcome: "failed",
        error: {
          code: "provider_auth_required",
          phase: "credentials",
          message: "Reconnect the provider.",
          resolution: "Reconnect the provider account, then retry.",
        },
      }),
    ];
    const monitor = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      read: async () => response(events),
      persist: async (value) => {
        states.push(value);
        return true;
      },
    });

    await expect(monitor.poll()).resolves.toMatchObject({ accepted: 3 });
    expect(states).toHaveLength(3);
    expect(states[1]?.state).toMatchObject({
      sequence: 2,
      activity: "working",
      diagnostic: { code: "provider_auth_required" },
    });
    expect(monitor.latestFailure).toMatchObject({
      code: "provider_auth_required",
    });
    expect(monitor.failureReasonForExit()).toContain(
      "Reconnect the provider account, then retry.",
    );
  });

  test("does not let advisory idle clear native attention", async () => {
    let persisted: { attentionState: unknown } | undefined;
    const monitor = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      initialAttentionState: "auth_required",
      read: async () =>
        response([
          event(1, {
            type: "agent.status",
            status: "idle",
            attention: null,
            source: "herdr",
          }),
        ]),
      persist: async (value) => {
        persisted = value;
        return true;
      },
    });

    await monitor.poll();
    expect(persisted?.attentionState).toBe("auth_required");
  });

  test("allows a native explicit clear after recovery", async () => {
    let persisted:
      | { attentionState: unknown; state: { diagnostic: unknown } }
      | undefined;
    const monitor = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      initialAttentionState: "auth_required",
      initialState: {
        version: 1,
        attemptId,
        sequence: 1,
        eventId: "33333333-3333-4333-8333-000000000001",
        source: "native.codex",
        observedAt: "2026-09-17T12:00:00.000Z",
        activity: "idle",
        outcome: null,
        diagnostic: agentRuntimeError("codex_auth_required"),
      },
      read: async () =>
        response([
          event(2, {
            type: "agent.status",
            status: "working",
            attention: null,
            source: "native.codex",
          }),
        ]),
      persist: async (value) => {
        persisted = value;
        return true;
      },
    });

    await monitor.poll();
    expect(persisted?.attentionState).toBeNull();
    expect(persisted?.state.diagnostic).toBeNull();
  });

  test("does not downgrade native authentication to advisory input attention", async () => {
    let attention: string | null = null;
    const monitor = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      initialAttentionState: "auth_required",
      read: async () =>
        response([
          event(1, {
            type: "agent.status",
            source: "herdr",
            status: "idle",
            attention: "input_required",
          }),
        ]),
      persist: async (value) => {
        attention = value.attentionState;
        return true;
      },
    });
    await monitor.poll();
    expect(attention).toBe("auth_required");
  });

  test("rejects an event response bound to another attempt", async () => {
    let writes = 0;
    const monitor = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      read: async () =>
        JSON.stringify({
          version: 1,
          taskId,
          attemptId: "44444444-4444-4444-8444-444444444444",
          events: [],
          nextSequence: 0,
          hasMore: false,
        }),
      persist: async () => {
        writes += 1;
        return true;
      },
    });

    await expect(monitor.poll()).resolves.toMatchObject({
      accepted: 0,
      unavailable: true,
    });
    expect(writes).toBe(0);
  });

  test("keeps sequence monotonic and ignores a replay", async () => {
    let reads = 0;
    let writes = 0;
    const first = event(1, {
      type: "agent.status",
      status: "working",
      attention: null,
    });
    const monitor = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      read: async ({ afterSequence }) => {
        reads += 1;
        return afterSequence === 0 ? response([first]) : response([first]);
      },
      persist: async () => {
        writes += 1;
        return true;
      },
    });

    await monitor.poll();
    await monitor.poll();
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });

  test("retries a missing reader or transport after the runtime becomes ready", async () => {
    let reads = 0;
    let writes = 0;
    const monitor = new AgentRuntimeEventMonitor({
      taskId,
      attemptId,
      runId: attemptId,
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error("event helper is not ready");
        return response([
          event(1, {
            type: "agent.status",
            status: "working",
            attention: null,
          }),
        ]);
      },
      persist: async () => {
        writes += 1;
        return true;
      },
    });

    await expect(monitor.poll()).resolves.toMatchObject({ unavailable: true });
    await expect(monitor.poll()).resolves.toMatchObject({ accepted: 1 });
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });
});
