use opentelemetry::propagation::{Extractor, Injector, TextMapPropagator};
use opentelemetry_sdk::propagation::TraceContextPropagator;
use tracing::Span;
use tracing_opentelemetry::OpenTelemetrySpanExt;

struct TraceparentCarrier<'a>(&'a str);

impl Extractor for TraceparentCarrier<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        match key {
            "traceparent" => Some(self.0),
            _ => None,
        }
    }

    fn keys(&self) -> Vec<&str> {
        vec!["traceparent"]
    }
}

struct TraceparentSink(Option<String>);

impl Injector for TraceparentSink {
    fn set(&mut self, key: &str, value: String) {
        if key == "traceparent" {
            self.0 = Some(value);
        }
    }
}

pub fn attach_parent(span: &Span, traceparent: Option<&str>) {
    let Some(traceparent) = traceparent else {
        return;
    };
    let context = TraceContextPropagator::new().extract(&TraceparentCarrier(traceparent));
    span.set_parent(context);
}

/// serialise this span's own trace context into a W3C `traceparent`. forwarded
/// to the detached work span so it nests *under* this request span instead of
/// re-parenting to the original caller (which would make request and work
/// siblings). returns `None` when no otel layer is active (telemetry feature
/// off) or the span context is otherwise invalid.
pub fn current_traceparent(span: &Span) -> Option<String> {
    let mut sink = TraceparentSink(None);
    TraceContextPropagator::new().inject_context(&span.context(), &mut sink);
    sink.0
}
