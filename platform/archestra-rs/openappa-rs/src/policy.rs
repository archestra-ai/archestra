//! Compile host-managed TOML without reading container files or executing commands.
use appa_eventlog::{Backend, LogStore};
use appa_runtime::{
    api::Runtime,
    config::{Config, HostDefaults},
};
use std::{sync::Arc, time::Duration};

pub(crate) fn compile(content: &str) -> Result<Config, String> {
    Config::hosted(
        content,
        HostDefaults {
            consult_timeout: Duration::from_millis(5000),
            max_body_bytes: 65536,
        },
    )
    .map_err(|error| error.to_string())
}

pub(crate) fn validate(content: &str) -> Result<(), String> {
    let config = compile(content)?;
    let store = LogStore::open(Backend::Memory).map_err(|error| error.to_string())?;
    Runtime::open_with_store(config, Arc::new(store), None).map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn embedded_remedy_accepts_symbolic_audience_without_sources() {
        use appa_runtime::hooks;
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
        let result = runtime
            .execute_embedded_remedy(&actor, serde_json::from_value(args).unwrap())
            .await;
        assert!(
            !matches!(result, appa_runtime::api::RemedyOutcome::Refused { .. }),
            "{result:?}"
        );
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
