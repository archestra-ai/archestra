//! Compile host-managed TOML without reading container files or executing commands.
//!
//! The runtime opens under the Archestra adapter: every tool name the host hands it
//! derives to a canonical identity (`<catalog>__<tool>` → `mcp/<catalog>/<tool>`), so a
//! battery rule written canonically reaches an installed catalog through the
//! `server_aliases` table the host composes into the document.
use appa_eventlog::{Backend, LogStore};
use appa_runtime::{
    api::Runtime,
    config::{Config, HostDefaults, HostedBattery, IncludeResolution},
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

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

/// Validate a root document that declares no battery: [`compose`] with nothing to
/// resolve. A root whose `include` list names a battery does not validate this way —
/// the entry resolves to nothing — so a caller holding declarations composes instead.
pub(crate) fn validate(content: &str) -> Result<(), String> {
    compose(content, &[]).map(|_| ())
}

/// Where a battery's `command` helpers are served from once the host runs them:
/// every binding becomes `url = "<url_base>/<external name>"` authenticated by
/// `token_env`, the runtime's own variable, never the provider's.
pub(crate) struct HelperBinding {
    pub url_base: String,
    pub token_env: String,
}

/// One battery the host resolved for an include entry of the root document: the
/// entry as authored, the name the battery composes under, its `appa.toml` text and
/// the endpoint its `command` helpers are served from, if the host serves them.
pub(crate) struct ResolvedBattery {
    pub entry: String,
    pub name: String,
    pub policy: String,
    pub helpers: Option<HelperBinding>,
}

/// A composed document: the bytes the runtime stores and reloads through [`compile`],
/// and the credential table the root declared, variable → store key.
#[derive(Debug)]
pub(crate) struct Composed {
    pub content: String,
    pub credentials: BTreeMap<String, String>,
}

/// Compose the effective document: the root's own declarations — its `include` list,
/// its `[server_aliases]` and its `[credentials]` — with every included battery under
/// it by the runtime's include rules. An entry `batteries` does not answer is
/// unresolved, which the runtime refuses naming the entry. The composed document is
/// opened in a memory runtime, so a composition that returns is also a validation.
pub(crate) fn compose(root: &str, batteries: &[ResolvedBattery]) -> Result<Composed, String> {
    let document: toml::Table =
        toml::from_str(root).map_err(|error| format!("root policy: {error}"))?;
    refuse_host_keys(&document)?;
    let policies = batteries
        .iter()
        .map(bind_helpers)
        .collect::<Result<Vec<_>, _>>()?;
    // A battery reads one variable at most: the bridge token of the helpers this host
    // bound for it.
    let granted: Vec<Vec<&str>> = batteries
        .iter()
        .map(|battery| {
            battery
                .helpers
                .iter()
                .map(|binding| binding.token_env.as_str())
                .collect()
        })
        .collect();
    let resolved: Vec<(&str, HostedBattery<'_>)> = batteries
        .iter()
        .zip(&policies)
        .zip(&granted)
        .map(|((battery, policy), token_env)| {
            (
                battery.entry.as_str(),
                HostedBattery {
                    name: &battery.name,
                    policy,
                    token_env,
                },
            )
        })
        .collect();
    let config = Config::hosted_included(root, defaults(), |entry| {
        resolved
            .iter()
            .find(|(spelling, _)| *spelling == entry)
            .map(|(_, battery)| *battery)
            .ok_or(IncludeResolution::Unknown)
    })
    .map_err(|error| error.to_string())?;
    let content = String::from_utf8(config.policy_file().bytes().to_vec())
        .map_err(|error| error.to_string())?;
    let credentials = config.credentials().clone();
    let store = LogStore::open(Backend::Memory).map_err(|error| error.to_string())?;
    open(config, Arc::new(store))?;
    Ok(Composed {
        content,
        credentials,
    })
}

/// Rewrite a battery's `command` externals onto the host's helper endpoint. A
/// battery composed without a binding keeps its commands, which the hosted
/// composition then refuses: an unbound helper never silently drops out.
fn bind_helpers(battery: &ResolvedBattery) -> Result<String, String> {
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

/// What only the host may write into a root document: its own variables. The alias
/// table is the root's declaration now, so nothing else here is the host's.
fn refuse_host_keys(document: &toml::Table) -> Result<(), String> {
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
    const GITHUB_ENTRY: &str = "batteries/github/appa.toml";
    const LINEAR_ENTRY: &str = "batteries/linear@sha256-3f9c/appa.toml";

    fn github_battery() -> ResolvedBattery {
        ResolvedBattery {
            entry: GITHUB_ENTRY.into(),
            name: "github".into(),
            policy: "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/github/get_file_contents\"\ndelta = {}\n".into(),
            helpers: None,
        }
    }

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
            &format!(
                "include = [\"{GITHUB_ENTRY}\"]\n[server_aliases]\ngithub = [\"github_prod\"]\n[policy]\nversion = 2\n[[policy.tool]]\nname = \"github_prod__get_me\"\ndelta = {{}}\n[[policy.tool]]\nname = \"read\"\ndelta = {{}}\n"
            ),
            &[github_battery()],
        )
        .unwrap()
        .content;
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

    #[tokio::test]
    async fn embedded_runtime_derives_external_client_local_tool_spellings() {
        let runtime = memory_runtime(
            r#"[policy]
version = 2
[[policy.tool]]
name = "host/archestra/exec_command"
delta = {}
[[policy.tool]]
name = "host/archestra/read_file"
delta = {}
[[policy.tool]]
name = "host/archestra/Bash"
delta = {}
"#,
        );
        let actor = started(&runtime, "external-client-local-tools").await;
        for tool in ["exec_command", "read_file", "Bash"] {
            let decision = hooks::handle(&runtime, call(&actor, tool)).await;
            assert!(
                matches!(decision, HookDecision::AllowCall { .. }),
                "{tool} must derive to its host/archestra identity: {decision:?}"
            );
        }
        assert!(matches!(
            hooks::handle(&runtime, call(&actor, "unknown_local_tool")).await,
            HookDecision::Refuse { .. }
        ));
    }

    /// The document a trajectory opened under keeps judging it after the serving
    /// policy changes: a recompile never rewrites an open conversation's rules.
    #[tokio::test]
    async fn an_open_trajectory_is_judged_by_the_document_it_opened_under() {
        let root = format!("include = [\"{GITHUB_ENTRY}\"]\n[policy]\nversion = 2\n");
        let aliased = compose(
            &format!("{root}[server_aliases]\ngithub = [\"github_prod\"]\n"),
            &[github_battery()],
        )
        .unwrap()
        .content;
        let unaliased = compose(&root, &[github_battery()]).unwrap().content;
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

    /// The `[[policy.tool]]` rules of a composed document, in the order it states them.
    fn tool_names(content: &str) -> Vec<String> {
        let document: toml::Table = toml::from_str(content).unwrap();
        document["policy"]["tool"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect()
    }

    /// The root declares which batteries compose under it; the host answers the
    /// entries it holds, and the entry list is consumed by the composition.
    #[test]
    fn the_root_declares_its_batteries_its_aliases_and_its_credentials() {
        let root = format!(
            r#"include = [
  "{GITHUB_ENTRY}",   # the bundled battery
  "{LINEAR_ENTRY}",
]

[server_aliases]
github = ["github_prod"]
linear = ["linear"]

[credentials]
APPA_PROVIDER_GITHUB_TOKEN = "github_prod_token"

[policy]
version = 2
[[policy.tool]]
name = "read"
delta = {{}}
"#
        );
        let linear = || {
            ResolvedBattery {
            entry: LINEAR_ENTRY.into(),
            name: "linear".into(),
            policy: "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/linear/create_issue\"\ndelta = {}\n".into(),
            helpers: None,
        }
        };
        let composed = compose(&root, &[github_battery(), linear()]).unwrap();
        assert_eq!(
            tool_names(&composed.content),
            [
                "read",
                "mcp/github/get_file_contents",
                "mcp/linear/create_issue"
            ]
        );
        assert_eq!(
            composed.credentials,
            BTreeMap::from([(
                "APPA_PROVIDER_GITHUB_TOKEN".to_owned(),
                "github_prod_token".to_owned()
            )])
        );
        let document: toml::Table = toml::from_str(&composed.content).unwrap();
        assert!(
            !document.contains_key("include"),
            "the composition consumes the include list: {}",
            composed.content
        );
        assert_eq!(
            document["server_aliases"]["github"][0].as_str(),
            Some("github_prod")
        );
        // The stored bytes are a hosted document: they reload as they are.
        assert_eq!(
            String::from_utf8(
                compile(&composed.content)
                    .unwrap()
                    .policy_file()
                    .bytes()
                    .to_vec()
            )
            .unwrap(),
            composed.content
        );

        // An entry no resolved battery answers takes the composition down, naming it.
        let unresolved = compose(&root, &[github_battery()]).unwrap_err();
        assert!(unresolved.contains(LINEAR_ENTRY), "{unresolved}");

        // A stale entry the host answers with an empty battery composes: one entry
        // that stopped resolving never takes the whole policy down.
        let stale = ResolvedBattery {
            policy: "[policy]\nversion = 2\n".into(),
            ..linear()
        };
        let composed = compose(&root, &[github_battery(), stale]).unwrap();
        assert_eq!(
            tool_names(&composed.content),
            ["read", "mcp/github/get_file_contents"]
        );
    }

    #[test]
    fn composition_binds_helpers_to_the_bridge_and_is_deterministic() {
        // SAFETY: tests in this module that read the variable all set the same value,
        // and nothing else in the process reads it.
        unsafe { std::env::set_var(BRIDGE_TOKEN_ENV, "bridge-token") };
        let battery = || ResolvedBattery {
            entry: GITHUB_ENTRY.into(),
            name: "github".into(),
            policy: r#"[policy]
version = 2
[[policy.annotator]]
name = "github.repository-visibility"
ranks = ["suspicious"]
audiences = ["internal"]
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
        let root = format!(
            "include = [\"{GITHUB_ENTRY}\"]\n[server_aliases]\ngithub = [\"github_prod\"]\n[policy]\nversion = 2\n"
        );
        let composed = compose(&root, &[battery()]).unwrap().content;
        assert_eq!(composed, compose(&root, &[battery()]).unwrap().content);
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
        let unbound = ResolvedBattery {
            helpers: None,
            ..battery()
        };
        assert!(compose(&root, &[unbound]).is_err());
    }

    /// The alias table is the root's own declaration now, not the host's insertion.
    #[test]
    fn the_root_may_author_its_alias_table() {
        assert!(
            validate("[server_aliases]\ngithub = [\"github_prod\"]\n[policy]\nversion = 2\n")
                .is_ok()
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
        assert!(compose(root, &[]).is_err());
        assert!(validate("[policy]\nversion = 2\n").is_ok());
        for policy in [
            "[policy]\nversion = 2\n[externals.authorities.review]\nurl = 'https://attacker.example/review'\ntoken_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"\n",
            "[policy]\nversion = 2\n[externals.authorities.review]\nurl = 'https://attacker.example/review'\n",
        ] {
            let battery = ResolvedBattery {
                entry: "batteries/acme/appa.toml".to_owned(),
                name: "acme".to_owned(),
                policy: policy.to_owned(),
                helpers: None,
            };
            assert!(
                compose(
                    "include = [\"batteries/acme/appa.toml\"]\n[policy]\nversion = 2\n",
                    &[battery]
                )
                .is_err()
            );
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
