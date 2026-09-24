//! Export only APPA's value-safe target. The Node host supplies configuration
//! and flushes this addon's providers before exit; policy code owns no exporter.

use std::collections::HashMap;

#[cfg(all(test, feature = "telemetry"))]
#[path = "telemetry_tests.rs"]
mod tests;

pub(crate) struct Config {
    /// The host's normalized, per-signal trace URL, not an OTLP base URL.
    pub traces_endpoint: String,
    pub headers: HashMap<String, String>,
    pub instance_id: String,
}

pub(crate) fn init(config: Config) {
    #[cfg(feature = "telemetry")]
    imp::init(config);
    #[cfg(not(feature = "telemetry"))]
    let _ = (config.traces_endpoint, config.headers, config.instance_id);
}

pub(crate) fn flush() {
    #[cfg(feature = "telemetry")]
    imp::flush();
}

#[cfg(feature = "telemetry")]
mod imp {
    use std::sync::OnceLock;
    use std::time::Instant;

    use opentelemetry::{KeyValue, global, trace::TracerProvider};
    use opentelemetry_appender_tracing::layer::OpenTelemetryTracingBridge;
    use opentelemetry_otlp::{WithExportConfig, WithHttpConfig};
    use opentelemetry_sdk::{
        Resource, logs::SdkLoggerProvider, metrics::SdkMeterProvider, trace::SdkTracerProvider,
    };
    use tracing_subscriber::{
        Layer, filter::filter_fn, layer::SubscriberExt, util::SubscriberInitExt,
    };

    use super::Config;

    struct Providers {
        tracer: SdkTracerProvider,
        logger: SdkLoggerProvider,
        meter: SdkMeterProvider,
    }

    // One pipeline per native addon, not per policy revision or trajectory.
    static PROVIDERS: OnceLock<Option<Providers>> = OnceLock::new();

    pub(super) fn init(config: Config) {
        PROVIDERS.get_or_init(|| match build(config) {
            Ok(providers) => Some(providers),
            Err(()) => {
                // SDK errors can contain collector credentials. Never print them.
                eprintln!("openappa-rs: cannot initialize OTLP export; telemetry is disabled");
                None
            }
        });
    }

    fn build(config: Config) -> Result<Providers, ()> {
        let base = config
            .traces_endpoint
            .strip_suffix("/v1/traces")
            .ok_or(())?;
        appa_runtime::tls::install_crypto_provider();
        let resource = Resource::builder_empty()
            .with_attributes([
                KeyValue::new("service.name", "appa-runtime"),
                KeyValue::new("service.namespace", "archestra"),
                // Distinguish cumulative counters from concurrent backend processes.
                KeyValue::new("service.instance.id", config.instance_id),
            ])
            .build();
        // Build all exporters before starting their background workers.
        let spans = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(&config.traces_endpoint)
            .with_headers(config.headers.clone())
            .build()
            .map_err(|_| ())?;
        let logs = opentelemetry_otlp::LogExporter::builder()
            .with_http()
            .with_endpoint(format!("{base}/v1/logs"))
            .with_headers(config.headers.clone())
            .build()
            .map_err(|_| ())?;
        let metrics = opentelemetry_otlp::MetricExporter::builder()
            .with_http()
            .with_endpoint(format!("{base}/v1/metrics"))
            .with_headers(config.headers)
            .build()
            .map_err(|_| ())?;
        let providers = Providers {
            tracer: SdkTracerProvider::builder()
                .with_resource(resource.clone())
                .with_batch_exporter(spans)
                .build(),
            logger: SdkLoggerProvider::builder()
                .with_resource(resource.clone())
                .with_batch_exporter(logs)
                .build(),
            meter: SdkMeterProvider::builder()
                .with_resource(resource)
                .with_periodic_exporter(metrics)
                .build(),
        };
        // RUST_LOG and content-capture settings cannot widen this allowlist.
        let subscriber = tracing_subscriber::registry()
            .with(
                tracing_opentelemetry::layer()
                    .with_tracer(providers.tracer.tracer("appa-runtime"))
                    .with_filter(filter_fn(|metadata| metadata.target() == "appa_telemetry")),
            )
            .with(
                OpenTelemetryTracingBridge::new(&providers.logger)
                    .with_filter(filter_fn(|metadata| metadata.target() == "appa_telemetry")),
            );
        if subscriber.try_init().is_err() {
            // Do not replace a subscriber installed by another host component.
            let _ = providers.meter.shutdown();
            let _ = providers.logger.shutdown();
            let _ = providers.tracer.shutdown();
            return Err(());
        }
        global::set_meter_provider(providers.meter.clone());
        let started = Instant::now();
        global::meter("appa-runtime")
            .u64_observable_gauge("appa.runtime.uptime")
            .with_unit("s")
            .with_callback(move |observer| observer.observe(started.elapsed().as_secs(), &[]))
            .build();
        Ok(providers)
    }

    pub(super) fn flush() {
        if let Some(Some(providers)) = PROVIDERS.get() {
            // Run on a blocking worker while the native Tokio runtime is alive.
            let results = [
                providers.meter.force_flush(),
                providers.logger.force_flush(),
                providers.tracer.force_flush(),
            ];
            if results.iter().any(Result::is_err) {
                eprintln!("openappa-rs: OTLP flush failed; some telemetry may be lost");
            }
        }
    }
}
