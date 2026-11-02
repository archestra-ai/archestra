import {
  type Attributes,
  type Context,
  createTraceState,
  type Link,
  type SpanKind,
  trace,
} from "@opentelemetry/api";
import {
  type ReadableSpan,
  type Sampler,
  SamplingDecision,
  type SamplingResult,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { SESSION_ID_KEY } from "@/observability/request-context";

// W3C vendor trace-state entries preserve each export pipeline's independent
// decision even though the SDK has one shared recording/sampled bit.
const KEYS = {
  otlp: "archestra-otlp",
  diagnostics: "archestra-diagnostics",
} as const;
type Pipeline = keyof typeof KEYS;

export class PipelineSampler implements Sampler {
  constructor(
    private readonly otlp: Sampler,
    private readonly diagnostics: Sampler,
    private readonly verbose: boolean,
  ) {}
  shouldSample(
    ctx: Context,
    traceId: string,
    name: string,
    kind: SpanKind,
    attributes: Attributes,
    links: Link[],
  ): SamplingResult {
    const diagnostic = this.diagnostics.shouldSample(
      ctx,
      traceId,
      name,
      kind,
      attributes,
      links,
    );
    const parent = trace.getSpanContext(ctx);
    const eligible =
      this.verbose ||
      Boolean(attributes["route.category"]) ||
      Boolean(ctx.getValue(SESSION_ID_KEY));
    if (!eligible && !parent?.traceState?.get(KEYS.otlp)) return diagnostic;
    const customer = this.otlp.shouldSample(
      ctx,
      traceId,
      name,
      kind,
      attributes,
      links,
    );
    const decision = (pipeline: Pipeline, fallback: SamplingResult) => {
      const inherited = parent?.traceState?.get(KEYS[pipeline]);
      return inherited === undefined
        ? fallback.decision
        : inherited === "1"
          ? SamplingDecision.RECORD_AND_SAMPLED
          : SamplingDecision.NOT_RECORD;
    };
    const otlp = decision("otlp", customer);
    const diagnostics = decision("diagnostics", diagnostic);
    return {
      ...diagnostic,
      decision: Math.max(otlp, diagnostics),
      traceState: (
        diagnostic.traceState ??
        parent?.traceState ??
        createTraceState()
      )
        .set(
          KEYS.otlp,
          otlp === SamplingDecision.RECORD_AND_SAMPLED ? "1" : "0",
        )
        .set(
          KEYS.diagnostics,
          diagnostics === SamplingDecision.RECORD_AND_SAMPLED ? "1" : "0",
        ),
    };
  }
  toString(): string {
    return "PipelineSampler";
  }
}

/** The union is recorded once; each destination still receives only its own sample. */
export class PipelineSpanProcessor implements SpanProcessor {
  constructor(
    private readonly delegate: SpanProcessor,
    private readonly pipeline: Pipeline,
  ) {}
  onStart(span: Span, ctx: Context): void {
    if (span.spanContext().traceState?.get(KEYS[this.pipeline]) !== "0")
      this.delegate.onStart(span, ctx);
  }
  onEnd(span: ReadableSpan): void {
    if (span.spanContext().traceState?.get(KEYS[this.pipeline]) !== "0")
      this.delegate.onEnd(span);
  }
  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}
