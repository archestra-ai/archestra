import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  ParentBasedSampler,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";
import { PipelineSampler, PipelineSpanProcessor } from "./pipeline-sampling";

for (const [customer, diagnostics] of [
  [true, false],
  [false, true],
  [true, true],
  [false, false],
]) {
  test(`independent pipeline decisions survive nested and remote children: OTLP=${customer}, diagnostics=${diagnostics}`, async () => {
    const otlp = new InMemorySpanExporter();
    const internal = new InMemorySpanExporter();
    const sampler = (on: boolean) =>
      new ParentBasedSampler({
        root: on ? new AlwaysOnSampler() : new AlwaysOffSampler(),
      });
    const provider = new BasicTracerProvider({
      sampler: new PipelineSampler(
        sampler(customer),
        sampler(diagnostics),
        false,
      ),
      spanProcessors: [
        new PipelineSpanProcessor(new SimpleSpanProcessor(otlp), "otlp"),
        new PipelineSpanProcessor(
          new SimpleSpanProcessor(internal),
          "diagnostics",
        ),
      ],
    });
    try {
      const tracer = provider.getTracer("test");
      const parent = tracer.startSpan("turn", {
        attributes: { "route.category": "chat" },
      });
      const child = tracer.startSpan(
        "inference",
        { attributes: { "route.category": "llm-proxy" } },
        trace.setSpan(ROOT_CONTEXT, parent),
      );
      const remote = tracer.startSpan(
        "tool",
        { attributes: { "route.category": "mcp-gateway" } },
        trace.setSpanContext(ROOT_CONTEXT, {
          ...parent.spanContext(),
          isRemote: true,
        }),
      );
      remote.end();
      child.end();
      parent.end();
      await provider.forceFlush();
      expect(otlp.getFinishedSpans()).toHaveLength(customer ? 3 : 0);
      expect(internal.getFinishedSpans()).toHaveLength(diagnostics ? 3 : 0);
      if (customer)
        expect(
          new Set(otlp.getFinishedSpans().map((s) => s.spanContext().traceId))
            .size,
        ).toBe(1);
    } finally {
      await provider.shutdown();
    }
  });
}
