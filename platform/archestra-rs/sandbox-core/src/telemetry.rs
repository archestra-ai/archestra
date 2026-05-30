//! process-global OTLP telemetry pipeline (traces + logs).
//!
//! the napi binding calls [`init`] on first use. it wires the existing
//! `#[tracing::instrument]` spans and `tracing` log events into the same
//! collector the node SDK targets — the W3C traceparent forwarded by the
//! caller already stitches these rust spans under the parent trace.
//!
//! metrics are intentionally omitted for now: the dev collector exposes no
//! metrics pipeline, and the node side scrapes prometheus separately. would-be
//! gauges (durations, sizes, saturation) are recorded as span fields instead,
//! which travel on the working traces pipeline.

/// idempotent. safe to call on every napi entry; the heavy setup runs once.
/// a no-op unless the `telemetry` feature is enabled.
pub fn init() {
    #[cfg(feature = "telemetry")]
    imp::init();
}

/// force-flush pending traces/logs. call on graceful shutdown so the last
/// (unexported) batch isn't lost. idempotent; a no-op unless the `telemetry`
/// feature is enabled and `init` has run.
pub fn flush() {
    #[cfg(feature = "telemetry")]
    imp::flush();
}

/// matches the node SDK default; the per-signal `/v1/...` path is appended
/// explicitly because the http exporter uses a provided endpoint verbatim.
#[cfg(any(feature = "telemetry", test))]
const DEFAULT_ENDPOINT: &str = "http://localhost:4318";

/// reduce the shared endpoint env var to a bare base. it may hold either a
/// base (`http://host:4318`), a version base (`.../v1`), or a per-signal url
/// (`.../v1/traces`, what the node trace exporter wants), so any of those
/// suffixes is stripped back to the base that each signal then appends its own
/// path to. the singular `/v1/trace` / `/v1/log` are common typos the node
/// helper also tolerates, so they're stripped too for parity. order matters:
/// longer suffixes are tried before shorter ones (`/v1/traces` before
/// `/v1/trace` before `/v1`) so the loop's first match doesn't truncate early.
#[cfg(any(feature = "telemetry", test))]
fn normalize_base(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    for suffix in [
        "/v1/traces",
        "/v1/trace",
        "/v1/logs",
        "/v1/log",
        "/v1/metrics",
        "/v1",
    ] {
        if let Some(base) = trimmed.strip_suffix(suffix) {
            return base.trim_end_matches('/').to_string();
        }
    }
    trimmed.to_string()
}

#[cfg(feature = "telemetry")]
mod imp {
    use std::collections::HashMap;
    use std::env;
    use std::sync::{Once, OnceLock};

    use base64::prelude::{BASE64_STANDARD, Engine as _};
    use opentelemetry::KeyValue;
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
    use opentelemetry_otlp::{LogExporter, SpanExporter, WithExportConfig, WithHttpConfig};
    use opentelemetry_sdk::Resource;
    use opentelemetry_sdk::propagation::TraceContextPropagator;
    use opentelemetry_sdk::runtime;
    use tracing_subscriber::filter::LevelFilter;
    use tracing_subscriber::prelude::*;
    use tracing_subscriber::{EnvFilter, Layer};

    use super::{DEFAULT_ENDPOINT, normalize_base};

    const SERVICE_NAME: &str = "archestra-sandbox-rs";

    // keep both providers alive for the process lifetime: dropping either tears
    // down its batch-export task, and they're also what `flush` force-flushes on
    // shutdown. the tracer is additionally registered globally for propagation.
    static TRACER_PROVIDER: OnceLock<opentelemetry_sdk::trace::TracerProvider> = OnceLock::new();
    static LOGGER_PROVIDER: OnceLock<opentelemetry_sdk::logs::LoggerProvider> = OnceLock::new();
    static INIT: Once = Once::new();

    pub(super) fn init() {
        INIT.call_once(|| {
            if let Err(err) = try_init() {
                // telemetry must never break the sandbox: report and carry on.
                eprintln!("sandbox-rs: telemetry init failed: {err}");
            }
        });
    }

    fn try_init() -> Result<(), Box<dyn std::error::Error>> {
        let base = base_endpoint();
        let headers = auth_headers();
        let resource = Resource::new(vec![
            KeyValue::new("service.name", SERVICE_NAME),
            KeyValue::new("service.version", env!("CARGO_PKG_VERSION")),
        ]);

        // --- traces ---
        let mut span_builder = SpanExporter::builder()
            .with_http()
            .with_endpoint(format!("{base}/v1/traces"));
        if let Some(h) = headers.clone() {
            span_builder = span_builder.with_headers(h);
        }
        let tracer_provider = opentelemetry_sdk::trace::TracerProvider::builder()
            .with_batch_exporter(span_builder.build()?, runtime::Tokio)
            .with_resource(resource.clone())
            .build();
        let tracer = tracer_provider.tracer(SERVICE_NAME);
        // retain a handle for `flush`; the clone shares the same batch processor.
        let _ = TRACER_PROVIDER.set(tracer_provider.clone());
        opentelemetry::global::set_tracer_provider(tracer_provider);

        // --- logs ---
        let mut log_builder = LogExporter::builder()
            .with_http()
            .with_endpoint(format!("{base}/v1/logs"));
        if let Some(h) = headers {
            log_builder = log_builder.with_headers(h);
        }
        let logger_provider = opentelemetry_sdk::logs::LoggerProvider::builder()
            .with_batch_exporter(log_builder.build()?, runtime::Tokio)
            .with_resource(resource)
            .build();
        let log_bridge = OpenTelemetryTracingBridge::new(&logger_provider);
        let _ = LOGGER_PROVIDER.set(logger_provider);

        // emit a W3C traceparent on any outbound context (defense in depth; the
        // sandbox is a leaf today but may itself call traced services later).
        opentelemetry::global::set_text_map_propagator(TraceContextPropagator::new());

        tracing_subscriber::registry()
            // the env filter governs LOG verbosity only (fmt + the otel log
            // bridge). it is deliberately NOT applied to the span layer: lowering
            // it to warn/error to quiet native logs must not also drop the
            // info-level instrument spans the traces pipeline depends on.
            .with(
                // local visibility (tilt/container logs); ansi off for log scrapers.
                tracing_subscriber::fmt::layer()
                    .with_ansi(false)
                    .with_writer(std::io::stderr)
                    .with_filter(log_filter()),
            )
            .with(
                tracing_opentelemetry::layer()
                    .with_tracer(tracer)
                    .with_filter(LevelFilter::INFO),
            )
            .with(log_bridge.with_filter(log_filter()))
            .try_init()?;

        Ok(())
    }

    /// log verbosity for fmt/Loki output, from the standard `RUST_LOG`, defaulting
    /// to `info`. kept separate from the span layer so it can be tuned without
    /// disabling traces.
    fn log_filter() -> EnvFilter {
        EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"))
    }

    pub(super) fn flush() {
        if let Some(provider) = TRACER_PROVIDER.get() {
            for result in provider.force_flush() {
                if let Err(err) = result {
                    eprintln!("sandbox-rs: trace flush failed: {err}");
                }
            }
        }
        if let Some(provider) = LOGGER_PROVIDER.get() {
            for result in provider.force_flush() {
                if let Err(err) = result {
                    eprintln!("sandbox-rs: log flush failed: {err}");
                }
            }
        }
    }

    /// the shared env var may hold either a bare base (`http://host:4318`) or a
    /// per-signal url (`.../v1/traces`, what the node trace exporter wants). strip
    /// any signal suffix back to the base so each signal can append its own path.
    fn base_endpoint() -> String {
        env::var("ARCHESTRA_OTEL_EXPORTER_OTLP_ENDPOINT")
            .ok()
            .map(|s| normalize_base(&s))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string())
    }

    /// mirrors the node side: a bearer token takes precedence, otherwise a
    /// username/password pair falls back to HTTP basic auth. both become an
    /// `Authorization` header; nothing configured means no header.
    fn auth_headers() -> Option<HashMap<String, String>> {
        let trimmed_env = |key| {
            env::var(key)
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
        };

        if let Some(bearer) = trimmed_env("ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_BEARER") {
            return Some(auth_header(format!("Bearer {bearer}")));
        }

        // basic auth requires both halves; a lone username or password is ignored.
        let username = trimmed_env("ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_USERNAME")?;
        let password = trimmed_env("ARCHESTRA_OTEL_EXPORTER_OTLP_AUTH_PASSWORD")?;
        let encoded = BASE64_STANDARD.encode(format!("{username}:{password}"));
        Some(auth_header(format!("Basic {encoded}")))
    }

    fn auth_header(value: String) -> HashMap<String, String> {
        HashMap::from([("Authorization".to_string(), value)])
    }
}

#[cfg(test)]
mod tests {
    use super::normalize_base;

    #[test]
    fn normalize_base_strips_per_signal_suffix() {
        // bare base is left alone
        assert_eq!(normalize_base("http://host:4318"), "http://host:4318");
        // trailing slash is trimmed
        assert_eq!(normalize_base("http://host:4318/"), "http://host:4318");
        // a per-signal suffix (what the node trace exporter is configured with)
        // is stripped back to the base so we don't double it to /v1/traces/v1/...
        assert_eq!(
            normalize_base("http://host:4318/v1/traces"),
            "http://host:4318"
        );
        assert_eq!(
            normalize_base("http://host:4318/v1/logs"),
            "http://host:4318"
        );
        // a bare version base (supported by the node endpoint helpers) is
        // stripped too, so we don't double it to /v1/v1/traces
        assert_eq!(normalize_base("http://host:4318/v1"), "http://host:4318");
        assert_eq!(normalize_base("http://host:4318/v1/"), "http://host:4318");
        // the singular /v1/trace and /v1/log typos (which the node helper also
        // tolerates) are stripped back to the base, not appended onto.
        assert_eq!(
            normalize_base("http://host:4318/v1/trace"),
            "http://host:4318"
        );
        assert_eq!(
            normalize_base("http://host:4318/v1/log"),
            "http://host:4318"
        );
        // a custom path that is not a signal suffix is preserved
        assert_eq!(
            normalize_base("http://host:4318/otlp"),
            "http://host:4318/otlp"
        );
    }
}
