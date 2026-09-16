//! Compile host-managed TOML without reading container files or executing commands.
use appa_eventlog::{Backend, LogStore};
use appa_runtime::{
    api::Runtime,
    config::{Binding, Config, ExternalBindings},
};
use serde::Deserialize;
use std::{collections::BTreeMap, sync::Arc, time::Duration};

pub(crate) fn compile(content: &str) -> Result<Config, String> {
    let document: Document = toml::from_str(content).map_err(|error| error.to_string())?;
    let mut bindings = ExternalBindings::new(
        Duration::from_millis(document.externals.timeout_ms),
        document.externals.max_body_bytes,
    );
    if let Some(timeout) = document.externals.review_timeout_ms {
        bindings.review_timeout_ms = timeout;
    }
    bindings.authorities = convert(document.externals.authorities)?;
    bindings.sanitizers = convert(document.externals.sanitizers)?;
    bindings.annotators = convert(document.externals.annotators)?;
    bindings.audience = convert(document.externals.audience)?;
    Config::embedded(
        toml::to_string(&document.policy).map_err(|error| error.to_string())?,
        bindings,
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn validate(content: &str) -> Result<(), String> {
    let config = compile(content)?;
    let store = LogStore::open(Backend::Memory).map_err(|error| error.to_string())?;
    Runtime::open_with_store(config, Arc::new(store), None).map_err(|error| error.to_string())?;
    Ok(())
}

fn convert(entries: BTreeMap<String, External>) -> Result<BTreeMap<String, Binding>, String> {
    entries
        .into_iter()
        .map(|(name, entry)| {
            let binding = match (entry.url, entry.builtin, entry.token_env) {
                (Some(url), None, token_env) => Binding::Url { url, token_env },
                (None, Some(builtin), None) => Binding::Builtin(builtin),
                _ => {
                    return Err(format!(
                        "External {name} needs either url (with optional token_env) or builtin"
                    ));
                }
            };
            Ok((name, binding))
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    policy: toml::Value,
    #[serde(default)]
    externals: Externals,
}

// Policy editors configure remote/builtin bindings, never backend shell access
// or file includes. Reject unsupported fields rather than silently dropping them.
#[derive(Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Externals {
    timeout_ms: u64,
    review_timeout_ms: Option<u64>,
    max_body_bytes: usize,
    authorities: BTreeMap<String, External>,
    sanitizers: BTreeMap<String, External>,
    annotators: BTreeMap<String, External>,
    audience: BTreeMap<String, External>,
}
impl Default for Externals {
    fn default() -> Self {
        Self {
            timeout_ms: 5000,
            review_timeout_ms: None,
            max_body_bytes: 65536,
            authorities: BTreeMap::new(),
            sanitizers: BTreeMap::new(),
            annotators: BTreeMap::new(),
            audience: BTreeMap::new(),
        }
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct External {
    url: Option<String>,
    token_env: Option<String>,
    builtin: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn embedded_remedy_accepts_symbolic_audience_without_sources() {
        use appa_runtime::{hooks, mcp};
        use appa_runtime_api::{Actor, HookDecision, HookEvent, ProposedCall, TrajectoryId};

        let config = compile(
            r#"[policy]
version = 2
[[policy.tool]]
name = "read_internal"
delta = { audience = ["internal"] }
requires = { audience = { within = ["internal"] } }
"#,
        )
        .unwrap();
        let store = Arc::new(LogStore::open(Backend::Memory).unwrap());
        let runtime = Runtime::open_with_store(config, store, None).unwrap();
        let actor = Actor {
            root: TrajectoryId("symbolic-approval".into()),
            child: None,
        };
        assert_eq!(
            hooks::handle(
                &runtime,
                HookEvent::SessionStart {
                    root: actor.root.clone()
                }
            )
            .await,
            HookDecision::Ack
        );
        let call = || HookEvent::ToolCall {
            call_id: None,
            actor: actor.clone(),
            call: ProposedCall {
                tool: "read_internal".into(),
                arguments: serde_json::value::RawValue::from_string("{}".into()).unwrap(),
            },
            spawn: false,
            ruling: None,
        };
        let HookDecision::DenyCall { offers, .. } = hooks::handle(&runtime, call()).await else {
            panic!("the read must require acceptance before executing");
        };
        let args = serde_json::json!({ "offer_id": offers[0].id });
        assert_eq!(
            hooks::handle(
                &runtime,
                HookEvent::ToolCall {
                    call_id: None,
                    actor: actor.clone(),
                    call: ProposedCall {
                        tool: appa_runtime_api::CONTROL_TOOL.into(),
                        arguments: serde_json::value::RawValue::from_string(args.to_string())
                            .unwrap(),
                    },
                    spawn: false,
                    ruling: None,
                }
            )
            .await,
            HookDecision::PassControl
        );
        let result =
            mcp::execute_embedded_remedy(&runtime, &actor, serde_json::from_value(args).unwrap())
                .await;
        assert_ne!(result.is_error, Some(true), "{result:?}");
        assert!(matches!(
            hooks::handle(&runtime, call()).await,
            HookDecision::AllowCall { .. }
        ));
    }

    #[test]
    fn validates_contracts_not_just_toml() {
        assert!(
            validate("[policy]\nversion = 2\n[[policy.tool]]\nname = 'read'\ndelta = {}\n").is_ok()
        );
        assert!(validate("[policy]\nversion = 999\n").is_err());
        assert!(
            validate(
                "[policy]\nversion = 2\n[[policy.tool]]\nname = 'read'\nannotator = 'missing'\n"
            )
            .is_err()
        );
        assert!(validate("[policy\n").is_err());
    }

    #[test]
    fn refuses_container_access_and_unknown_fields() {
        for suffix in [
            "include = ['secret.toml']\n[policy]\nversion = 2",
            "[policy]\nversion = 2\n[externals.annotators.x]\ncommand = ['sh', '-c', 'true']",
            "[policy]\nversion = 2\n[externals]\ntiemout_ms = 10",
        ] {
            assert!(compile(suffix).is_err());
        }
    }

    #[test]
    fn keeps_declared_external_bindings() {
        let config = compile("[policy]\nversion = 2\n[externals.authorities.review]\nurl = 'https://example.com/review'\n").unwrap();
        assert!(
            String::from_utf8_lossy(config.policy_file().bytes())
                .contains("https://example.com/review")
        );
    }
}
