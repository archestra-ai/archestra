use opentelemetry::propagation::{Extractor, TextMapPropagator};
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

pub fn attach_parent(span: &Span, traceparent: Option<&str>) {
    let Some(traceparent) = traceparent else {
        return;
    };
    let context = TraceContextPropagator::new().extract(&TraceparentCarrier(traceparent));
    span.set_parent(context);
}
