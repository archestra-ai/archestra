use std::{
    collections::HashMap,
    process::Command,
    sync::{Arc, Mutex},
};

use appa_eventlog::{Backend, LogStore};
use appa_runtime::hooks;
use appa_runtime_api::{Actor, HookDecision, HookEvent, ProposedCall, TrajectoryId};
use axum::{
    Router,
    body::Bytes,
    http::{HeaderMap, StatusCode, Uri},
};
use opentelemetry_proto::tonic::{
    collector::{
        logs::v1::ExportLogsServiceRequest, metrics::v1::ExportMetricsServiceRequest,
        trace::v1::ExportTraceServiceRequest,
    },
    common::v1::{KeyValue, any_value::Value},
    metrics::v1::{metric::Data, number_data_point},
};
use prost::Message;

const SECRET: &str = "raw-value-must-never-enter-otlp";
const TOKEN: &str = "Bearer collector-test-only";

// Global providers/subscribers must be isolated from other tests and each other.
#[test]
fn otlp_export_contract() {
    let Ok(mode) = std::env::var("ARCHESTRA_APPA_TELEMETRY_TEST_MODE") else {
        for mode in ["enabled", "disabled", "unavailable", "subscriber_collision"] {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "telemetry::tests::otlp_export_contract",
                    "--nocapture",
                ])
                .env("ARCHESTRA_APPA_TELEMETRY_TEST_MODE", mode)
                .env("RUST_LOG", "trace")
                .env("ARCHESTRA_OTEL_CAPTURE_CONTENT", "true")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{mode}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap()
        .block_on(check_export(&mode));
}

async fn check_export(mode: &str) {
    let records = Arc::new(Mutex::new(Vec::<(String, Bytes)>::new()));
    let captured = records.clone();
    let app = Router::new().fallback(move |uri: Uri, headers: HeaderMap, body: Bytes| {
        let captured = captured.clone();
        async move {
            assert_eq!(headers.get("authorization").unwrap(), TOKEN);
            assert_eq!(
                headers.get("content-type").unwrap(),
                "application/x-protobuf"
            );
            captured.lock().unwrap().push((uri.path().to_owned(), body));
            StatusCode::OK
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/custom", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    if mode == "subscriber_collision" {
        tracing::subscriber::set_global_default(tracing::subscriber::NoSubscriber::default())
            .unwrap();
    }
    if mode != "disabled" {
        let endpoint = if mode == "unavailable" {
            let unused = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            format!("http://{}/custom", unused.local_addr().unwrap())
        } else {
            base.clone()
        };
        tokio::task::spawn_blocking(move || {
            let config = || super::Config {
                traces_endpoint: format!("{endpoint}/v1/traces"),
                headers: HashMap::from([("Authorization".into(), TOKEN.into())]),
                instance_id: "backend-a:17".into(),
            };
            super::init(config());
            super::init(config()); // Reinitialization must not duplicate signals.
        })
        .await
        .unwrap();
    }
    tracing::warn!(target: "ordinary_diagnostics", value = SECRET, "must not export");
    let runtime = tokio::task::spawn_blocking(|| {
        crate::policy::open(
            crate::policy::compile(
                r#"
[policy]
version = 2
[[policy.tool]]
name = "read_plain"
delta = {}
[[policy.tool]]
name = "write_blocked"
delta = {}
requires = { attention = ["blocked"] }
"#,
            )
            .unwrap(),
            Arc::new(LogStore::open(Backend::Memory).unwrap()),
        )
        .unwrap()
    })
    .await
    .unwrap();
    for (tool, root, allowed) in [
        ("read_plain", "archestra:allow", true),
        ("write_blocked", "archestra:deny", false),
    ] {
        let actor = Actor {
            root: TrajectoryId(root.into()),
            child: None,
        };
        assert_eq!(
            hooks::handle(
                &runtime,
                HookEvent::SessionStart {
                    root: actor.root.clone(),
                    principal: None
                }
            )
            .await,
            HookDecision::Ack
        );
        let decision = hooks::handle(
            &runtime,
            HookEvent::ToolCall {
                actor,
                call: ProposedCall {
                    tool: format!("host/archestra/{tool}"),
                    arguments: serde_json::value::RawValue::from_string(format!(
                        r#"{{"value":"{SECRET}"}}"#
                    ))
                    .unwrap(),
                    cwd: None,
                },
                call_id: Some(format!("call-{tool}")),
                spawn: false,
                ruling: None,
            },
        )
        .await;
        assert_eq!(
            matches!(decision, HookDecision::AllowCall { .. }),
            allowed,
            "{decision:?}"
        );
        if !allowed {
            assert!(
                matches!(decision, HookDecision::DenyCall { .. }),
                "{decision:?}"
            );
        }
    }
    tokio::task::spawn_blocking(super::flush).await.unwrap();
    let records = records.lock().unwrap();
    if mode != "enabled" {
        assert!(records.is_empty(), "{mode} unexpectedly exported records");
        server.abort();
        return;
    }
    let mut spans = Vec::new();
    let mut logs = Vec::new();
    let mut metrics = Vec::new();
    for (path, body) in records.iter() {
        assert!(!String::from_utf8_lossy(body).contains(SECRET));
        assert!(!String::from_utf8_lossy(body).contains(TOKEN));
        match path.as_str() {
            "/custom/v1/traces" => {
                let request = ExportTraceServiceRequest::decode(body.clone()).unwrap();
                for resource in request.resource_spans {
                    check_resource(&resource.resource.unwrap().attributes);
                    spans.extend(
                        resource
                            .scope_spans
                            .into_iter()
                            .flat_map(|scope| scope.spans),
                    );
                }
            }
            "/custom/v1/logs" => {
                let request = ExportLogsServiceRequest::decode(body.clone()).unwrap();
                for resource in request.resource_logs {
                    check_resource(&resource.resource.unwrap().attributes);
                    logs.extend(
                        resource
                            .scope_logs
                            .into_iter()
                            .flat_map(|scope| scope.log_records),
                    );
                }
            }
            "/custom/v1/metrics" => {
                let request = ExportMetricsServiceRequest::decode(body.clone()).unwrap();
                for resource in request.resource_metrics {
                    check_resource(&resource.resource.unwrap().attributes);
                    metrics.extend(
                        resource
                            .scope_metrics
                            .into_iter()
                            .flat_map(|scope| scope.metrics),
                    );
                }
            }
            _ => panic!("incorrect signal endpoint: {path}"),
        }
    }
    let checks: Vec<_> = spans
        .iter()
        .filter(|s| s.name == "appa.policy.check")
        .collect();
    assert_eq!(checks.len(), 2);
    let decisions: Vec<_> = logs
        .iter()
        .filter(|l| string_attr(&l.attributes, "appa.event.name") == Some("appa.policy.decision"))
        .collect();
    assert_eq!(decisions.len(), 2);
    for log in decisions {
        assert!(!log.trace_id.is_empty());
        let span = checks
            .iter()
            .find(|s| s.trace_id == log.trace_id && s.span_id == log.span_id)
            .unwrap();
        assert_eq!(
            string_attr(&span.attributes, "appa.outcome"),
            string_attr(&log.attributes, "appa.outcome")
        );
        assert!(string_attr(&span.attributes, "appa.trajectory.root").is_some());
        assert!(string_attr(&span.attributes, "appa.policy.id").is_some());
    }
    let counter = metrics
        .iter()
        .find(|m| m.name == "appa.policy.decisions")
        .unwrap();
    let Some(Data::Sum(sum)) = &counter.data else {
        panic!("not a counter")
    };
    assert_eq!(sum.data_points.len(), 2);
    for point in &sum.data_points {
        assert_eq!(point.attributes.len(), 1);
        assert!(matches!(
            string_attr(&point.attributes, "outcome"),
            Some("allowed" | "denied")
        ));
        assert_eq!(point.value, Some(number_data_point::Value::AsInt(1)));
    }
    assert!(
        metrics
            .iter()
            .any(|m| m.name == "appa.policy.check.duration")
    );
    assert!(metrics.iter().any(|m| m.name == "appa.runtime.uptime"));
    server.abort();
}

fn check_resource(attributes: &[KeyValue]) {
    assert_eq!(
        string_attr(attributes, "service.name"),
        Some("appa-runtime")
    );
    assert_eq!(
        string_attr(attributes, "service.namespace"),
        Some("archestra")
    );
    assert_eq!(
        string_attr(attributes, "service.instance.id"),
        Some("backend-a:17")
    );
}

fn string_attr<'a>(attributes: &'a [KeyValue], name: &str) -> Option<&'a str> {
    attributes
        .iter()
        .find(|a| a.key == name)
        .and_then(|a| a.value.as_ref())
        .and_then(|v| match &v.value {
            Some(Value::StringValue(value)) => Some(value.as_str()),
            _ => None,
        })
}
