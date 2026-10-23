import assert from "node:assert/strict";

export class RoundtripMeasurements {
  #now;
  #started = false;
  #ended = false;
  #success = false;
  #events = [];
  #providerEvidenceComplete = false;

  constructor({ now = () => performance.now() } = {}) {
    this.#now = now;
  }

  startTask() {
    assert.equal(this.#started, false, "task_already_started");
    this.#started = true;
  }

  begin({
    kind,
    role = "unknown",
    operation = null,
    requestHash = null,
    startedMs = this.#now(),
  }) {
    assert.ok(KINDS.includes(kind) && ROLES.includes(role));
    assert.ok(
      Number.isFinite(startedMs) && startedMs >= 0 && startedMs <= this.#now(),
      "invalid_roundtrip_start",
    );
    assert.ok(
      operation === null ||
        (typeof operation === "string" && /^[a-z_]{1,64}$/.test(operation)),
    );
    assert.ok(
      requestHash === null ||
        (typeof requestHash === "string" && /^[0-9a-f]{64}$/.test(requestHash)),
    );
    const event = {
      id: this.#events.length,
      kind,
      role,
      operation,
      requestHash,
      startedMs,
      endedMs: null,
      durationMs: null,
      status: "open",
      httpStatus: null,
    };
    this.#events.push(event);
    return event.id;
  }

  end({ id, status = "complete", httpStatus = null }) {
    const event = this.#events[id];
    assert.ok(event && event.status === "open", "roundtrip_not_open");
    assert.ok(["complete", "failed", "cancelled"].includes(status));
    assert.ok(
      httpStatus === null ||
        (Number.isInteger(httpStatus) &&
          httpStatus >= 100 &&
          httpStatus <= 599),
    );
    const endedMs = this.#now();
    assert.ok(endedMs >= event.startedMs, "non_monotonic_clock");
    Object.assign(event, {
      endedMs,
      durationMs: endedMs - event.startedMs,
      status,
      httpStatus,
    });
  }

  assignRole({ id, role }) {
    assert.ok(ROLES.includes(role) && role !== "unknown");
    const event = this.#events[id];
    assert.ok(
      event && (event.role === "unknown" || event.role === role),
      "conflicting_roundtrip_role",
    );
    event.role = role;
  }

  classify({ id, kind, role, operation, requestHash }) {
    const event = this.#events[id];
    assert.ok(event && event.status === "open");
    assert.ok(KINDS.includes(kind) && ROLES.includes(role));
    assert.ok(
      operation === null ||
        (typeof operation === "string" && /^[a-z_]{1,64}$/.test(operation)),
    );
    assert.ok(
      requestHash === null ||
        (typeof requestHash === "string" && /^[0-9a-f]{64}$/.test(requestHash)),
    );
    Object.assign(event, { kind, role, operation, requestHash });
  }

  finishTask({ success }) {
    assert.ok(this.#started && !this.#ended);
    this.#ended = true;
    this.#success = success === true;
  }

  snapshot() {
    return structuredClone(this.#events);
  }

  recordProviderAttempt({
    role = "unknown",
    durationMs,
    httpStatus,
    status,
    requestHash,
  }) {
    assert.ok(
      ROLES.includes(role) && Number.isFinite(durationMs) && durationMs >= 0,
    );
    assert.ok(["complete", "failed", "cancelled"].includes(status));
    assert.ok(
      Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599,
    );
    assert.match(requestHash, /^[0-9a-f]{64}$/);
    const event = {
      id: this.#events.length,
      kind: "provider",
      role,
      operation: null,
      requestHash,
      startedMs: null,
      endedMs: null,
      durationMs,
      status,
      httpStatus,
      source: "independent_upstream_observer",
    };
    this.#events.push(event);
    return event.id;
  }

  finishProviderEvidence() {
    assert.ok(
      this.#events
        .filter((event) => event.kind === "provider")
        .every((event) => event.status !== "open"),
    );
    this.#providerEvidenceComplete = true;
  }

  summary() {
    const groups = Object.fromEntries(
      KINDS.map((kind) => {
        const events = this.#events.filter((event) => event.kind === kind);
        return [
          kind,
          {
            ...summarize(events),
            roles: Object.fromEntries(
              ROLES.map((role) => [
                role,
                summarize(events.filter((event) => event.role === role)),
              ]),
            ),
          },
        ];
      }),
    );
    return {
      taskSuccess: this.#success,
      providerEvidenceComplete: this.#providerEvidenceComplete,
      upstreamAttempts: this.#providerEvidenceComplete
        ? groups.provider.attempts
        : null,
      openRoundtrips: this.#events.filter((event) => event.status === "open")
        .length,
      groups,
      definitions: {
        llm_client:
          "Every model HTTP attempt at the client/proxy boundary, including retries and failures.",
        provider:
          "Every upstream model HTTP attempt, independently counted, including retries; not assumed equal to ingress attempts.",
        llm_setup:
          "Model discovery/token-count HTTP requests, separate from inference roundtrips.",
        mcp_tool:
          "Every MCP tools/call attempt, including policy helpers, retries, denied calls, and failures.",
        mcp_setup:
          "MCP discovery/lifecycle requests; separate from tool execution counts.",
        mcp_stream:
          "Long-lived MCP event-stream connections; lifetimes are not request roundtrip latencies.",
        latency:
          "Monotonic attempt duration; all-settled and successful-only quantiles are separate. Open requests have unknown duration, not zero.",
      },
    };
  }
}

function summarize(events) {
  const measured = events
    .filter((event) => Number.isFinite(event.durationMs))
    .map((event) => event.durationMs);
  const successful = events
    .filter(
      (event) =>
        event.status === "complete" && Number.isFinite(event.durationMs),
    )
    .map((event) => event.durationMs);
  return {
    attempts: events.length,
    complete: events.filter((event) => event.status === "complete").length,
    failed: events.filter((event) => event.status === "failed").length,
    cancelled: events.filter((event) => event.status === "cancelled").length,
    open: events.filter((event) => event.status === "open").length,
    allSettledLatencyMs: distribution(measured),
    successfulLatencyMs: distribution(successful),
  };
}

function distribution(values) {
  if (!values.length)
    return {
      samples: 0,
      total: null,
      p50: null,
      p95: null,
      min: null,
      max: null,
    };
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return {
    samples: sorted.length,
    total: sorted.reduce((a, b) => a + b, 0),
    p50: percentile(0.5),
    p95: percentile(0.95),
    min: sorted[0],
    max: sorted.at(-1),
  };
}

const KINDS = [
  "llm_client",
  "provider",
  "llm_setup",
  "mcp_tool",
  "mcp_setup",
  "mcp_stream",
];
const ROLES = ["parent", "child", "unknown"];
