import { type Span, type TracerProvider, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { type SpanTeamInfo, setTeamAttributes } from "./attributes";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let originalProvider: TracerProvider;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  originalProvider = trace.getTracerProvider();
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
});

afterAll(() => {
  provider.shutdown();
  trace.setGlobalTracerProvider(originalProvider);
});

/**
 * Run a callback inside a finished span and return the exported span so its
 * attributes can be asserted.
 */
function captureSpan(fn: (span: Span) => void): ReadableSpan {
  const tracer = trace.getTracer("test");
  const span = tracer.startSpan("test-span");
  fn(span);
  span.end();
  const spans = exporter.getFinishedSpans();
  return spans[spans.length - 1];
}

describe("setTeamAttributes", () => {
  test("sets array-valued team ids and names", () => {
    const teams: SpanTeamInfo[] = [
      { id: "t1", name: "Platform", labels: [] },
      { id: "t2", name: "Security", labels: [] },
    ];

    const span = captureSpan((s) => setTeamAttributes(s, teams));

    expect(span.attributes["archestra.team.ids"]).toEqual(["t1", "t2"]);
    expect(span.attributes["archestra.team.names"]).toEqual([
      "Platform",
      "Security",
    ]);
  });

  test("merges label values per key across teams (distinct, array-valued)", () => {
    const teams: SpanTeamInfo[] = [
      {
        id: "t1",
        name: "Platform",
        labels: [
          { key: "env", value: "prod" },
          { key: "region", value: "us-east-1" },
        ],
      },
      {
        id: "t2",
        name: "Security",
        labels: [
          { key: "env", value: "staging" },
          // Duplicate (env=prod) across teams collapses to a single value.
          { key: "env", value: "prod" },
        ],
      },
    ];

    const span = captureSpan((s) => setTeamAttributes(s, teams));

    const envValues = span.attributes["archestra.team.label.env"] as string[];
    expect([...envValues].sort()).toEqual(["prod", "staging"]);
    expect(span.attributes["archestra.team.label.region"]).toEqual([
      "us-east-1",
    ]);
  });

  test("is a no-op for empty or undefined teams", () => {
    const emptySpan = captureSpan((s) => setTeamAttributes(s, []));
    expect(emptySpan.attributes["archestra.team.ids"]).toBeUndefined();

    const undefinedSpan = captureSpan((s) => setTeamAttributes(s, undefined));
    expect(undefinedSpan.attributes["archestra.team.ids"]).toBeUndefined();
  });
});
