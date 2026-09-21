//! Compile host-managed TOML without reading container files or executing commands.
//!
//! The runtime opens under the Archestra adapter: every tool name the host hands it
//! derives to a canonical identity (`<catalog>__<tool>` → `mcp/<catalog>/<tool>`), so a
//! battery rule written canonically reaches an installed catalog through the
//! `server_aliases` table the host composes into the document.
use appa_eventlog::{Backend, LogStore};
use appa_runtime::{
    api::Runtime,
    config::{Config, HostDefaults, HostedBattery},
};
use std::{sync::Arc, time::Duration};

/// The consult budget every external of a hosted policy gets. Fixed for v0: the
/// helper bridge derives its own deadline from it.
pub(crate) const CONSULT_TIMEOUT: Duration = Duration::from_millis(5000);

fn defaults() -> HostDefaults {
    HostDefaults {
        consult_timeout: CONSULT_TIMEOUT,
        max_body_bytes: 65536,
    }
}

pub(crate) fn compile(content: &str) -> Result<Config, String> {
    Config::hosted(content, defaults()).map_err(|error| error.to_string())
}

/// Open a runtime over `store` under the Archestra adapter.
pub(crate) fn open(config: Config, store: Arc<LogStore>) -> Result<Runtime, String> {
    Runtime::open_with_store_as(config, store, None, crate::adapter::adapter())
        .map_err(|error| error.to_string())
}

/// The environment namespace the host keeps for itself: the bearer its helper
/// bridge checks lives here. A `url` external of a root policy or a battery may
/// name any other `APPA_` variable, but naming one of these would let its author
/// send the host's own credential wherever the external points.
pub(crate) const HOST_VARIABLE_PREFIX: &str = "APPA_ARCHESTRA_";

/// Validate a root document: what an author may save, before the host composes it.
pub(crate) fn validate(content: &str) -> Result<(), String> {
    let document: toml::Table =
        toml::from_str(content).map_err(|error| format!("root policy: {error}"))?;
    refuse_host_keys(&document)?;
    let config = compile(content)?;
    let store = LogStore::open(Backend::Memory).map_err(|error| error.to_string())?;
    open(config, Arc::new(store))?;
    Ok(())
}

/// One `server_aliases` entry: the connection a battery rule names, and the
/// catalog prefixes the deployment serves it under.
pub(crate) struct ServerAlias {
    pub alias: String,
    pub targets: Vec<String>,
}

/// Where a battery's `command` helpers are served from once the host runs them:
/// every binding becomes `url = "<url_base>/<external name>"` authenticated by
/// `token_env`, the runtime's own variable, never the provider's.
pub(crate) struct HelperBinding {
    pub url_base: String,
    pub token_env: String,
}

pub(crate) struct ComposeBattery {
    pub name: String,
    pub policy: String,
    pub helpers: Option<HelperBinding>,
}

/// Compose the effective document: the root with the host's `server_aliases`, then
/// every battery under it by the runtime's include rules. The result is the exact
/// bytes the runtime stores and reloads through [`compile`].
pub(crate) fn compose(
    root: &str,
    aliases: &[ServerAlias],
    batteries: &[ComposeBattery],
) -> Result<String, String> {
    let mut document: toml::Table =
        toml::from_str(root).map_err(|error| format!("root policy: {error}"))?;
    refuse_host_keys(&document)?;
    if !aliases.is_empty() {
        let mut table = toml::Table::new();
        for alias in aliases {
            let targets = alias
                .targets
                .iter()
                .map(|target| toml::Value::String(target.clone()))
                .collect();
            table.insert(alias.alias.clone(), toml::Value::Array(targets));
        }
        document.insert("server_aliases".to_owned(), toml::Value::Table(table));
    }
    let root = toml::to_string(&document).map_err(|error| error.to_string())?;
    let policies = batteries
        .iter()
        .map(bind_helpers)
        .collect::<Result<Vec<_>, _>>()?;
    let hosted: Vec<HostedBattery<'_>> = batteries
        .iter()
        .zip(&policies)
        .map(|(battery, policy)| HostedBattery {
            name: &battery.name,
            policy,
        })
        .collect();
    let config =
        Config::hosted_composed(&root, &hosted, defaults()).map_err(|error| error.to_string())?;
    String::from_utf8(config.policy_file().bytes().to_vec()).map_err(|error| error.to_string())
}

/// Rewrite a battery's `command` externals onto the host's helper endpoint. A
/// battery composed without a binding keeps its commands, which the hosted
/// composition then refuses: an unbound helper never silently drops out.
fn bind_helpers(battery: &ComposeBattery) -> Result<String, String> {
    let mut document: toml::Table = toml::from_str(&battery.policy)
        .map_err(|error| format!("battery {}: {error}", battery.name))?;
    refuse_host_variables(&document)
        .and_then(|()| refuse_url_externals(&document))
        .map_err(|error| format!("battery {}: {error}", battery.name))?;
    let Some(binding) = &battery.helpers else {
        return Ok(battery.policy.clone());
    };
    if let Some(toml::Value::Table(externals)) = document.get_mut("externals") {
        for (_, section) in externals.iter_mut() {
            let Some(section) = section.as_table_mut() else {
                continue;
            };
            for (name, entry) in section.iter_mut() {
                let Some(entry) = entry.as_table_mut() else {
                    continue;
                };
                if entry.remove("command").is_none() {
                    continue;
                }
                if !is_url_segment(name) {
                    return Err(format!(
                        "battery {}: external {name:?} cannot be addressed over the helper bridge",
                        battery.name
                    ));
                }
                entry.insert(
                    "url".to_owned(),
                    toml::Value::String(format!("{}/{name}", binding.url_base)),
                );
                entry.insert(
                    "token_env".to_owned(),
                    toml::Value::String(binding.token_env.clone()),
                );
            }
        }
    }
    toml::to_string(&document).map_err(|error| error.to_string())
}

/// What only the host may write into a root document: its alias table and its variables.
fn refuse_host_keys(document: &toml::Table) -> Result<(), String> {
    if document.contains_key("server_aliases") {
        return Err(
            "the root policy may not declare server_aliases: the host derives them from its catalogs"
                .to_owned(),
        );
    }
    refuse_host_variables(document)
}

/// A battery reaches out only through the host's helper bridge: a url external
/// would leave the API host with none of the bridge's guards.
pub(crate) fn refuse_url_externals(document: &toml::Table) -> Result<(), String> {
    for (section, name, binding) in external_bindings(document) {
        if binding.contains_key("url") {
            return Err(format!(
                "externals.{section}.{name:?} declares a url; a battery's externals must be command helpers"
            ));
        }
    }
    Ok(())
}

pub(crate) fn refuse_host_variables(document: &toml::Table) -> Result<(), String> {
    for (section, name, binding) in external_bindings(document) {
        if let Some(toml::Value::String(var)) = binding.get("token_env")
            && var.starts_with(HOST_VARIABLE_PREFIX)
        {
            return Err(format!(
                "externals.{section}.{name:?}: token_env may not name a {HOST_VARIABLE_PREFIX} variable, which the host keeps for itself"
            ));
        }
    }
    Ok(())
}

/// Every `[externals.<section>.<name>]` binding table, with its section and name.
pub(crate) fn external_bindings(document: &toml::Table) -> Vec<(&str, &str, &toml::Table)> {
    let Some(toml::Value::Table(externals)) = document.get("externals") else {
        return Vec::new();
    };
    externals
        .iter()
        .filter_map(|(section, bindings)| bindings.as_table().map(|bindings| (section, bindings)))
        .flat_map(|(section, bindings)| {
            bindings.iter().filter_map(move |(name, binding)| {
                binding
                    .as_table()
                    .map(|binding| (section.as_str(), name.as_str(), binding))
            })
        })
        .collect()
}

fn is_url_segment(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use appa_runtime::hooks;
    use appa_runtime_api::{Actor, HookDecision, HookEvent, ProposedCall, TrajectoryId};

    const BRIDGE_TOKEN_ENV: &str = "APPA_OPENAPPA_RS_TEST_BRIDGE_TOKEN";

    /// Every call carries its own id: an unidentified call stays outstanding until
    /// its result, and the host proposes one such call at a time.
    fn call(actor: &Actor, tool: &str) -> HookEvent {
        static CALLS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let call_id = CALLS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        HookEvent::ToolCall {
            call_id: Some(format!("call:{call_id}")),
            actor: actor.clone(),
            call: ProposedCall {
                tool: (crate::adapter::adapter().derive)(tool)
                    .expect("test tool names are well formed")
                    .canonical
                    .as_str()
                    .to_owned(),
                arguments: serde_json::value::RawValue::from_string("{}".into()).unwrap(),
            },
            spawn: false,
            ruling: None,
        }
    }

    fn actor(root: &str) -> Actor {
        Actor {
            root: TrajectoryId(root.into()),
            child: None,
        }
    }

    async fn started(runtime: &Runtime, root: &str) -> Actor {
        let actor = actor(root);
        assert_eq!(
            hooks::handle(
                runtime,
                HookEvent::SessionStart {
                    root: actor.root.clone()
                }
            )
            .await,
            HookDecision::Ack
        );
        actor
    }

    fn memory_runtime(content: &str) -> Runtime {
        let store = Arc::new(LogStore::open(Backend::Memory).unwrap());
        open(compile(content).unwrap(), store).unwrap()
    }

    #[tokio::test]
    async fn embedded_remedy_accepts_symbolic_audience_without_sources() {
        let runtime = memory_runtime(
            r#"[policy]
version = 2
[[policy.tool]]
name = "read_internal"
delta = { audience = ["internal"] }
requires = { audience = { within = ["internal"] } }
"#,
        );
        let actor = started(&runtime, "symbolic-approval").await;
        let HookDecision::DenyCall {
            offers, feedback, ..
        } = hooks::handle(&runtime, call(&actor, "read_internal")).await
        else {
            panic!("the read must require acceptance before executing");
        };
        assert!(
            feedback.contains(crate::adapter::CONTROL_TOOL_RAW) && !feedback.contains("appa/"),
            "the model is told to take the remedy through the control tool as this host spells it: {feedback}"
        );
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
            hooks::handle(&runtime, call(&actor, "read_internal")).await,
            HookDecision::AllowCall { .. }
        ));
    }

    /// A rule authored in the host's own spelling keeps matching the call it names,
    /// and a canonical battery rule reaches the catalog its alias binds — and only that
    /// catalog.
    #[tokio::test]
    async fn host_spelled_rules_and_aliased_battery_rules_judge_the_calls_they_name() {
        let content = compose(
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"github_prod__get_me\"\ndelta = {}\n[[policy.tool]]\nname = \"read\"\ndelta = {}\n",
            &[ServerAlias {
                alias: "github".into(),
                targets: vec!["github_prod".into()],
            }],
            &[ComposeBattery {
                name: "github".into(),
                policy: "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/github/get_file_contents\"\ndelta = {}\n".into(),
                helpers: None,
            }],
        )
        .unwrap();
        let runtime = memory_runtime(&content);
        let actor = started(&runtime, "aliases").await;
        for admitted in [
            "github_prod__get_me",
            "read",
            "github_prod__get_file_contents",
        ] {
            let decision = hooks::handle(&runtime, call(&actor, admitted)).await;
            assert!(
                matches!(decision, HookDecision::AllowCall { .. }),
                "{admitted} is named by a rule: {decision:?}"
            );
        }
        for refused in ["github_dev__get_file_contents", "github__get_file_contents"] {
            assert!(
                matches!(
                    hooks::handle(&runtime, call(&actor, refused)).await,
                    HookDecision::Refuse { .. }
                ),
                "{refused} is outside every rule"
            );
        }
    }

    /// The document a trajectory opened under keeps judging it after the serving
    /// policy changes: a recompile never rewrites an open conversation's rules.
    #[tokio::test]
    async fn an_open_trajectory_is_judged_by_the_document_it_opened_under() {
        let battery = || {
            ComposeBattery {
            name: "github".into(),
            policy: "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/github/get_file_contents\"\ndelta = {}\n".into(),
            helpers: None,
        }
        };
        let root = "[policy]\nversion = 2\n";
        let aliased = compose(
            root,
            &[ServerAlias {
                alias: "github".into(),
                targets: vec!["github_prod".into()],
            }],
            &[battery()],
        )
        .unwrap();
        let unaliased = compose(root, &[], &[battery()]).unwrap();
        let runtime = memory_runtime(&aliased);
        let old = started(&runtime, "opened-under-aliases").await;
        assert!(matches!(
            hooks::handle(&runtime, call(&old, "github_prod__get_file_contents")).await,
            HookDecision::AllowCall { .. }
        ));
        runtime.reload(compile(&unaliased).unwrap()).unwrap();
        let pinned = hooks::handle(&runtime, call(&old, "github_prod__get_file_contents")).await;
        assert!(
            matches!(pinned, HookDecision::AllowCall { .. }),
            "the open trajectory keeps its document: {pinned:?}"
        );
        let fresh = started(&runtime, "opened-after-reload").await;
        assert!(matches!(
            hooks::handle(&runtime, call(&fresh, "github_prod__get_file_contents")).await,
            HookDecision::Refuse { .. }
        ));
    }

    #[test]
    fn composition_binds_helpers_to_the_bridge_and_is_deterministic() {
        // SAFETY: tests in this module that read the variable all set the same value,
        // and nothing else in the process reads it.
        unsafe { std::env::set_var(BRIDGE_TOKEN_ENV, "bridge-token") };
        let battery = || ComposeBattery {
            name: "github".into(),
            policy: r#"[policy]
version = 2
[[policy.annotator]]
name = "github.repository-visibility"
ranks = ["suspicious"]
audiences = ["public"]
marks = []
[[policy.tool]]
name = "mcp/github/get_file_contents"
annotator = "github.repository-visibility"
[externals.annotators."github.repository-visibility"]
command = ["python3", "repository-visibility.py"]
token_env = "APPA_PROVIDER_GITHUB_TOKEN"
"#
            .into(),
            helpers: Some(HelperBinding {
                url_base: "http://127.0.0.1:9000/api/openappa/helpers/install-1".into(),
                token_env: BRIDGE_TOKEN_ENV.into(),
            }),
        };
        let aliases = [ServerAlias {
            alias: "github".into(),
            targets: vec!["github_prod".into()],
        }];
        let root = "[policy]\nversion = 2\n";
        let composed = compose(root, &aliases, &[battery()]).unwrap();
        assert_eq!(composed, compose(root, &aliases, &[battery()]).unwrap());
        let document: toml::Table = toml::from_str(&composed).unwrap();
        let binding = &document["externals"]["annotators"]["github.repository-visibility"];
        assert_eq!(
            binding["url"].as_str(),
            Some(
                "http://127.0.0.1:9000/api/openappa/helpers/install-1/github.repository-visibility"
            )
        );
        assert_eq!(binding["token_env"].as_str(), Some(BRIDGE_TOKEN_ENV));
        assert!(binding.get("command").is_none());
        assert_eq!(
            document["server_aliases"]["github"]
                .as_array()
                .map(Vec::len),
            Some(1)
        );
        // The composed bytes are a hosted document: they reload as they are.
        assert_eq!(
            String::from_utf8(compile(&composed).unwrap().policy_file().bytes().to_vec()).unwrap(),
            composed
        );
        // An unbound helper keeps its command, which a hosted document refuses.
        let unbound = ComposeBattery {
            helpers: None,
            ..battery()
        };
        assert!(compose(root, &aliases, &[unbound]).is_err());
        // The root does not own the alias table.
        assert!(
            compose(
                "[server_aliases]\ngithub = [\"x\"]\n[policy]\nversion = 2\n",
                &[],
                &[]
            )
            .is_err()
        );
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
    fn refuses_host_keys_in_the_root_and_host_variables_in_a_battery() {
        let root = "[policy]\nversion = 2\n[externals.authorities.review]\nurl = 'http://127.0.0.1:9000/api/openappa/helpers/x/y'\ntoken_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"\n";
        assert!(validate(root).is_err());
        assert!(compose(root, &[], &[]).is_err());
        let aliased = "[policy]\nversion = 2\n[server_aliases]\ngithub = ['github']\n";
        assert!(validate(aliased).is_err());
        assert!(compose(aliased, &[], &[]).is_err());
        assert!(validate("[policy]\nversion = 2\n").is_ok());
        for policy in [
            "[policy]\nversion = 2\n[externals.authorities.review]\nurl = 'https://attacker.example/review'\ntoken_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"\n",
            "[policy]\nversion = 2\n[externals.authorities.review]\nurl = 'https://attacker.example/review'\n",
        ] {
            let battery = ComposeBattery {
                name: "acme".to_owned(),
                policy: policy.to_owned(),
                helpers: None,
            };
            assert!(compose("[policy]\nversion = 2\n", &[], &[battery]).is_err());
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
