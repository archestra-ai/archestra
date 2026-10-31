//! Pull the embedded runtime's instruments into Archestra's authenticated scrape.
//! No listener, OTLP exporter, background task, or request identity is involved.

use opentelemetry::{KeyValue, global};
use opentelemetry_sdk::{
    error::{OTelSdkError, OTelSdkResult},
    metrics::{
        InstrumentKind, ManualReader, Pipeline, SdkMeterProvider, Stream, Temporality,
        data::{AggregatedMetrics, MetricData, ResourceMetrics},
        reader::MetricReader,
    },
};
use std::{
    fmt::Write,
    sync::{Arc, OnceLock, Weak},
    time::Duration,
};

#[derive(Clone, Debug)]
struct Reader(Arc<ManualReader>);

impl MetricReader for Reader {
    fn register_pipeline(&self, pipeline: Weak<Pipeline>) {
        self.0.register_pipeline(pipeline);
    }
    fn collect(&self, data: &mut ResourceMetrics) -> OTelSdkResult {
        self.0.collect(data)
    }
    fn force_flush(&self) -> OTelSdkResult {
        self.0.force_flush()
    }
    fn shutdown_with_timeout(&self, timeout: Duration) -> OTelSdkResult {
        self.0.shutdown_with_timeout(timeout)
    }
    fn temporality(&self, kind: InstrumentKind) -> Temporality {
        self.0.temporality(kind)
    }
}

struct Metrics {
    provider: SdkMeterProvider,
    reader: Reader,
}

static METRICS: OnceLock<Metrics> = OnceLock::new();

impl Metrics {
    fn new() -> Self {
        let reader = Reader(Arc::new(ManualReader::default()));
        let provider = SdkMeterProvider::builder()
            .with_reader(reader.clone())
            .with_view(|_| {
                Stream::builder()
                    .with_allowed_attribute_keys(
                        ["outcome", "role", "component", "error_type"]
                            .map(opentelemetry::Key::from),
                    )
                    .with_cardinality_limit(128)
                    .build()
                    .ok()
            })
            .build();
        Metrics { provider, reader }
    }
}

pub(crate) fn initialize() {
    METRICS.get_or_init(|| {
        let metrics = Metrics::new();
        global::set_meter_provider(metrics.provider.clone());
        metrics
    });
}

fn labels<'a>(attributes: impl Iterator<Item = &'a KeyValue>, extra: Option<f64>) -> String {
    let mut labels = Vec::new();
    for attribute in attributes {
        if !matches!(
            attribute.key.as_str(),
            "outcome" | "role" | "component" | "error_type"
        ) {
            continue;
        }
        let value = attribute
            .value
            .to_string()
            .replace('\\', "\\\\")
            .replace('\n', "\\n")
            .replace('"', "\\\"");
        labels.push(format!("{}=\"{}\"", attribute.key, value));
    }
    if let Some(bound) = extra {
        labels.push(format!(
            "le=\"{}\"",
            if bound.is_infinite() {
                "+Inf".to_owned()
            } else {
                bound.to_string()
            }
        ));
    }
    if labels.is_empty() {
        String::new()
    } else {
        format!("{{{}}}", labels.join(","))
    }
}

fn definition(instrument: &str) -> Option<(&'static str, &'static str, &'static str)> {
    Some(match instrument {
        "appa.policy.decisions" => (
            "appa_policy_decisions_total",
            "counter",
            "Embedded OpenAPPA policy decisions",
        ),
        "appa.policy.check.duration" => (
            "appa_policy_check_duration_seconds",
            "histogram",
            "Embedded OpenAPPA policy check duration in seconds",
        ),
        "appa.external.calls" => (
            "appa_external_calls_total",
            "counter",
            "Embedded OpenAPPA external calls",
        ),
        "appa.external.call.duration" => (
            "appa_external_call_duration_seconds",
            "histogram",
            "Embedded OpenAPPA external call duration in seconds",
        ),
        "appa.remedy.attempts" => (
            "appa_remedy_attempts_total",
            "counter",
            "Embedded OpenAPPA remedy attempts",
        ),
        "appa.remedy.duration" => (
            "appa_remedy_duration_seconds",
            "histogram",
            "Embedded OpenAPPA remedy duration in seconds",
        ),
        "appa.runtime.failures" => (
            "appa_runtime_failures_total",
            "counter",
            "Embedded OpenAPPA runtime failures",
        ),
        _ => return None,
    })
}

pub(crate) fn collect() -> Result<String, OTelSdkError> {
    let Some(metrics) = METRICS.get() else {
        return Ok(String::new());
    };
    collect_from(metrics)
}

fn collect_from(metrics: &Metrics) -> Result<String, OTelSdkError> {
    let mut data = ResourceMetrics::default();
    metrics.reader.collect(&mut data)?;
    let mut text = String::new();
    for scope in data
        .scope_metrics()
        .filter(|scope| scope.scope().name() == "appa-runtime")
    {
        for metric in scope.metrics() {
            let Some((name, kind, help)) = definition(metric.name()) else {
                continue;
            };
            let _ = writeln!(text, "# HELP {name} {help}\n# TYPE {name} {kind}");
            match metric.data() {
                AggregatedMetrics::U64(MetricData::Sum(sum)) => {
                    for point in sum.data_points() {
                        let _ = writeln!(
                            text,
                            "{name}{} {}",
                            labels(point.attributes(), None),
                            point.value()
                        );
                    }
                }
                AggregatedMetrics::F64(MetricData::Histogram(histogram)) => {
                    for point in histogram.data_points() {
                        let mut cumulative = 0;
                        for (count, bound) in point
                            .bucket_counts()
                            .zip(point.bounds().chain(std::iter::once(f64::INFINITY)))
                        {
                            cumulative += count;
                            let _ = writeln!(
                                text,
                                "{name}_bucket{} {cumulative}",
                                labels(point.attributes(), Some(bound))
                            );
                        }
                        let label_set = labels(point.attributes(), None);
                        let _ = writeln!(
                            text,
                            "{name}_sum{label_set} {}\n{name}_count{label_set} {}",
                            point.sum(),
                            point.count()
                        );
                    }
                }
                _ => {}
            }
        }
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cumulative_scrapes_export_native_instruments_without_request_data() {
        use opentelemetry::metrics::MeterProvider;
        let metrics = Metrics::new();
        let meter = metrics.provider.meter("appa-runtime");
        let attributes = [
            KeyValue::new("outcome", "allowed"),
            KeyValue::new("session_id", "private-session"),
        ];
        let counter = meter.u64_counter("appa.policy.decisions").build();
        let histogram = meter
            .f64_histogram("appa.policy.check.duration")
            .with_unit("s")
            .with_boundaries(vec![0.1, 1.0])
            .build();
        counter.add(2, &attributes);
        counter.add(
            1,
            &[
                KeyValue::new("outcome", "allowed"),
                KeyValue::new("session_id", "another-private-session"),
            ],
        );
        histogram.record(0.05, &attributes);
        histogram.record(0.5, &attributes);
        meter
            .u64_counter("private.unrelated")
            .build()
            .add(1, &attributes);
        let first = collect_from(&metrics).expect("reader collects");
        assert!(first.contains("appa_policy_decisions_total{outcome=\"allowed\"} 3\n"));
        assert!(first.contains(
            "appa_policy_check_duration_seconds_bucket{outcome=\"allowed\",le=\"0.1\"} 1\n"
        ));
        assert!(first.contains(
            "appa_policy_check_duration_seconds_bucket{outcome=\"allowed\",le=\"+Inf\"} 2\n"
        ));
        assert!(
            first.contains("appa_policy_check_duration_seconds_count{outcome=\"allowed\"} 2\n")
        );
        assert!(
            first.contains("appa_policy_check_duration_seconds_sum{outcome=\"allowed\"} 0.55\n")
        );
        assert!(!first.contains("private"));
        assert_eq!(
            first,
            collect_from(&metrics).expect("a scrape does not reset counters")
        );
        counter.add(1, &attributes);
        assert!(
            collect_from(&metrics)
                .expect("reader collects")
                .contains("appa_policy_decisions_total{outcome=\"allowed\"} 4\n")
        );
    }
}
