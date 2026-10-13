//! Compile host-managed TOML without reading container files or executing commands.
//!
//! The runtime opens under the Archestra adapter: every tool name the host hands it
//! derives to a canonical identity (`<catalog>__<tool>` → `mcp/<catalog>/<tool>`), so a
//! battery rule written canonically reaches an installed catalog through the
//! `server_aliases` table the host composes into the document.
use appa_eventlog::LogStore;
use appa_package::PackageName;
use appa_runtime::{
    api::Runtime,
    config::{ArchestraEndpoint, Config, HostDefaults, HostedBattery, IncludeResolution},
};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

/// The consult budget every external of a hosted policy gets. Fixed for v0: the
/// helper bridge derives its own deadline from it.
pub(crate) const CONSULT_TIMEOUT: Duration = Duration::from_millis(5000);

fn defaults() -> HostDefaults {
    HostDefaults {
        archestra: archestra_endpoint(),
        ..HostDefaults::new(CONSULT_TIMEOUT, host_max_body_bytes())
    }
}

/// The default body size limit for a policy that omits `max_body_bytes`: the LLM proxy's
/// limit, published by the backend before it crosses into the addon. Explicit policy
/// limits take precedence for external responses and carried tool results.
///
/// A process that has not published a value (a standalone script, a test), or published
/// one that is not a positive integer, keeps the policy's stated value or uses
/// [`FALLBACK_MAX_BODY_BYTES`] when the policy states none.
fn published_max_body_bytes() -> Option<usize> {
    parse_max_body_bytes(std::env::var(MAX_BODY_BYTES_ENV).ok().as_deref())
}

/// What a policy that states none gets, where the host publishes nothing.
pub(crate) fn host_max_body_bytes() -> usize {
    published_max_body_bytes().unwrap_or(FALLBACK_MAX_BODY_BYTES)
}

fn parse_max_body_bytes(published: Option<&str>) -> Option<usize> {
    published
        .and_then(|value| value.trim().parse::<usize>().ok())
        .filter(|bytes| *bytes > 0)
}

const MAX_BODY_BYTES_ENV: &str = "APPA_ARCHESTRA_MAX_BODY_BYTES";
const FALLBACK_MAX_BODY_BYTES: usize = 65536;

/// Where a `builtin = "archestra"` annotator posts its rendered prompt: the backend's own
/// route, behind the same per-process bearer the helper bridge checks. The host publishes
/// both before it crosses into the addon; a process that has not leaves the builtin
/// unconfigured, and a policy naming it fails to open.
fn archestra_endpoint() -> Option<ArchestraEndpoint> {
    let url = std::env::var(ARCHESTRA_ANNOTATOR_URL_ENV).ok()?;
    let token = std::env::var(BRIDGE_TOKEN_ENV).ok()?;
    Some(ArchestraEndpoint::new(url, token))
}

const ARCHESTRA_ANNOTATOR_URL_ENV: &str = "APPA_ARCHESTRA_ANNOTATOR_URL";
const BRIDGE_TOKEN_ENV: &str = "APPA_ARCHESTRA_BRIDGE_TOKEN";

/// Compile a hosted document, resolving every `token_env` it names through `lookup`.
pub(crate) fn compile(
    content: &str,
    lookup: impl Fn(&str) -> Option<String>,
) -> Result<Config, String> {
    Config::hosted(content, defaults(), lookup).map_err(|error| error.to_string())
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
/// entry as authored, the name the battery composes under, its base policy text, the
/// target policy text the host deploys before it, if any, and the endpoint its
/// `command` helpers are served from, if the host serves them.
pub(crate) struct ResolvedBattery {
    pub entry: String,
    pub name: String,
    pub policy: String,
    pub target: Option<String>,
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
/// checked as an open checks it, so a composition that returns is also a validation.
pub(crate) fn compose(root: &str, batteries: &[ResolvedBattery]) -> Result<Composed, String> {
    let document: toml::Table =
        toml::from_str(root).map_err(|error| format!("root policy: {error}"))?;
    refuse_host_variables(&document)?;
    let bound = batteries
        .iter()
        .map(|battery| Ok((battery, bind_helpers(battery)?)))
        .collect::<Result<Vec<_>, String>>()?;
    let hosted: Vec<(&ResolvedBattery, &BoundBattery, Vec<&str>)> = bound
        .iter()
        .map(|(battery, bound)| {
            let token_env = bound.token_env.iter().map(String::as_str).collect();
            (*battery, bound, token_env)
        })
        .collect();
    // No organization's values reach a composition: it is checked, stored and later
    // compiled per dispatch with the values the host resolves then.
    let config = Config::hosted_included_deferred(root, defaults(), |entry| {
        hosted
            .iter()
            .find(|(battery, _, _)| battery.entry == entry)
            .map(|(battery, bound, token_env)| HostedBattery {
                name: &battery.name,
                base: &bound.base,
                target: bound.target.as_deref(),
                token_env,
            })
            .ok_or(IncludeResolution::Unknown)
    })
    .map_err(|error| error.to_string())?;
    let content = String::from_utf8(config.policy_file().bytes().to_vec())
        .map_err(|error| error.to_string())?;
    let content = strip_default_result_cap(&document, content)?;
    let credentials = config.credentials().clone();
    Runtime::check_hosted(config, None, crate::adapter::adapter())
        .map_err(|error| error.to_string())?;
    Ok(Composed {
        content,
        credentials,
    })
}

/// The composed text is stored and compiled again at every dispatch, and that compile
/// gives a text that leaves `max_body_bytes` out the host's current default. A default
/// the composition materialised would freeze the value of the day it was composed, so a
/// root that states none leaves it out of the stored text. A stated value stays.
fn strip_default_result_cap(root: &toml::Table, content: String) -> Result<String, String> {
    let stated = root
        .get("externals")
        .and_then(toml::Value::as_table)
        .is_some_and(|externals| externals.contains_key("max_body_bytes"));
    if stated {
        return Ok(content);
    }
    let mut document = content
        .parse::<toml_edit::DocumentMut>()
        .map_err(|error| error.to_string())?;
    if let Some(externals) = document
        .get_mut("externals")
        .and_then(toml_edit::Item::as_table_mut)
    {
        externals.remove("max_body_bytes");
    }
    Ok(document.to_string())
}

/// A battery's policies as the host serves them, and the credential variables they read.
struct BoundBattery {
    base: String,
    target: Option<String>,
    token_env: Vec<String>,
}

/// Rewrite a battery's `command` externals onto the host's helper endpoint. A
/// battery composed without a binding keeps its commands, which the hosted
/// composition then refuses: an unbound helper never silently drops out. The
/// battery reads the bridge token of its bound helpers and the key its
/// `[externals.jev]` profile names inside the battery's own credential prefix: the
/// runtime sends that key to the jev endpoint alone.
fn bind_helpers(battery: &ResolvedBattery) -> Result<BoundBattery, String> {
    let base = battery_document(battery, &battery.policy)?;
    let target = battery
        .target
        .as_deref()
        .map(|target| battery_document(battery, target))
        .transpose()?;
    let jev_key = target
        .iter()
        .chain([&base])
        .find_map(jev_profile_variable)
        .filter(|variable| {
            PackageName::parse(&battery.name)
                .is_ok_and(|name| name.credential_prefix().owns(variable))
        });
    let Some(binding) = &battery.helpers else {
        return Ok(BoundBattery {
            base: battery.policy.clone(),
            target: battery.target.clone(),
            token_env: jev_key.into_iter().collect(),
        });
    };
    Ok(BoundBattery {
        base: bind_document(battery, base, binding)?,
        target: target
            .map(|target| bind_document(battery, target, binding))
            .transpose()?,
        token_env: std::iter::once(binding.token_env.clone())
            .chain(jev_key)
            .collect(),
    })
}

fn battery_document(battery: &ResolvedBattery, text: &str) -> Result<toml::Table, String> {
    let document: toml::Table =
        toml::from_str(text).map_err(|error| format!("battery {}: {error}", battery.name))?;
    refuse_host_variables(&document)
        .and_then(|()| refuse_url_externals(&document))
        .map_err(|error| format!("battery {}: {error}", battery.name))?;
    Ok(document)
}

fn bind_document(
    battery: &ResolvedBattery,
    mut document: toml::Table,
    binding: &HelperBinding,
) -> Result<String, String> {
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

/// Every `[externals.<section>.<name>]` binding table, with its section and name, and
/// every profile section (`[externals.jev]`, `[externals.llm]`) that names its
/// credential on the section itself, under its section's name.
pub(crate) fn external_bindings(document: &toml::Table) -> Vec<(&str, &str, &toml::Table)> {
    let Some(toml::Value::Table(externals)) = document.get("externals") else {
        return Vec::new();
    };
    externals
        .iter()
        .filter_map(|(section, bindings)| bindings.as_table().map(|bindings| (section, bindings)))
        .flat_map(|(section, bindings)| {
            let profile = bindings.contains_key("token_env").then_some((
                section.as_str(),
                section.as_str(),
                bindings,
            ));
            profile
                .into_iter()
                .chain(bindings.iter().filter_map(move |(name, binding)| {
                    binding
                        .as_table()
                        .map(|binding| (section.as_str(), name.as_str(), binding))
                }))
        })
        .collect()
}

/// The variable a document's `[externals.jev]` profile reads its key from.
fn jev_profile_variable(document: &toml::Table) -> Option<String> {
    document
        .get("externals")?
        .get(JEV_PROFILE)?
        .get("token_env")?
        .as_str()
        .map(str::to_owned)
}

/// The profile the stock `jev` annotator reads its key from.
const JEV_PROFILE: &str = "jev";

/// The `[[policy.<key>]]` entries a document declares.
pub(crate) fn policy_entries<'a>(document: &'a toml::Table, key: &str) -> &'a [toml::Value] {
    document
        .get("policy")
        .and_then(toml::Value::as_table)
        .and_then(|policy| policy.get(key))
        .and_then(toml::Value::as_array)
        .map_or(&[], Vec::as_slice)
}

/// The annotators a document's `[[policy.tool]]` rules route calls to, sorted and
/// once each. An annotator no rule names is never consulted.
pub(crate) fn routed_annotators(document: &toml::Table) -> Vec<String> {
    let routed: std::collections::BTreeSet<&str> = policy_entries(document, "tool")
        .iter()
        .filter_map(|rule| rule.get("annotator").and_then(toml::Value::as_str))
        .collect();
    routed.into_iter().map(str::to_owned).collect()
}

/// A name that stays one path segment under the helper endpoint: `.` and `..`
/// would resolve to another route.
fn is_url_segment(name: &str) -> bool {
    !name.is_empty()
        && name.chars().any(|character| character != '.')
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deployments::HostCredentials;
    use appa_eventlog::Backend;
    use appa_runtime::hooks;
    use appa_runtime_api::{Actor, HookDecision, HookEvent, ProposedCall, TrajectoryId};

    const BRIDGE_TOKEN_ENV: &str = "APPA_ARCHESTRA_OPENAPPA_RS_TEST_BRIDGE_TOKEN";

    /// The text a stored composition reloads as, less the result cap the host adds.
    fn reloaded_without_result_cap(content: &str) -> String {
        let reloaded =
            String::from_utf8(compile(content).unwrap().policy_file().bytes().to_vec()).unwrap();
        strip_default_result_cap(&toml::Table::new(), reloaded).unwrap()
    }

    /// A compilation no organization's values reach, as a composition's is.
    fn compile(content: &str) -> Result<Config, String> {
        super::compile(content, |var| HostCredentials::default().lookup(var))
    }
    const GITHUB_ENTRY: &str = "batteries/github/appa.toml";
    const LINEAR_ENTRY: &str = "batteries/linear@sha256-3f9c/appa.toml";

    fn github_battery() -> ResolvedBattery {
        ResolvedBattery {
            entry: GITHUB_ENTRY.into(),
            name: "github".into(),
            policy: "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/github/get_file_contents\"\ndelta = {}\n".into(),
            target: None,
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
                tool: (crate::adapter::adapter().identify_tool)(tool)
                    .expect("test tool names are well formed")
                    .canonical
                    .as_str()
                    .to_owned(),
                arguments: serde_json::value::RawValue::from_string("{}".into()).unwrap(),
                cwd: None,
            },
            spawn: None,
            prompt: None,
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
                    root: actor.root.clone(),
                    principal: None,
                    address: None,
                    title: None,
                    start: None,
                    launch: None,
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

    /// The platform proposes its yell as bare `yell`; the release must leave a standing the
    /// gateway's yell then spends, once.
    #[tokio::test]
    async fn a_released_platform_yell_is_vouched_for_its_session() {
        use appa_runtime::yell::embedded;
        let mut config = compile(
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/appa/yell\"\ndelta = {}\n[[policy.tool]]\nname = \"host/archestra/yell\"\ndelta = {}\n",
        )
        .unwrap();
        config.reporting.agent_yell = true;
        let runtime =
            Arc::new(open(config, Arc::new(LogStore::open(Backend::Memory).unwrap())).unwrap());
        let actor = started(&runtime, "yelling").await;
        let request = || embedded::Request {
            actor: actor.clone(),
            harness: crate::adapter::harness(),
            endpoint: "http://127.0.0.1:1".into(),
            hostname: None,
            message: "Agents are unhappy.".into(),
            with_trajectory: false,
        };
        let unvouched = embedded::send(&runtime, request()).await.unwrap_err();

        let release = HookEvent::ToolCall {
            call_id: Some("call:yell".into()),
            actor: actor.clone(),
            call: ProposedCall {
                tool: crate::canonical_tool("yell").unwrap(),
                arguments: serde_json::value::to_raw_value(&serde_json::json!({
                    "message": "Agents are unhappy.",
                    "with_trajectory": false,
                }))
                .unwrap(),
                cwd: None,
            },
            spawn: None,
            prompt: None,
            ruling: None,
        };
        assert!(matches!(
            hooks::handle(&runtime, release).await,
            HookDecision::AllowCall { .. }
        ));

        let spent = embedded::send(&runtime, request()).await.unwrap_err();
        assert_ne!(spent, unvouched, "the released call is found and spent");
        assert_eq!(
            embedded::send(&runtime, request()).await.unwrap_err(),
            unvouched,
            "a standing is spent once"
        );
    }

    #[tokio::test]
    async fn embedded_remedy_accepts_symbolic_audience_without_sources() {
        let runtime = memory_runtime(
            r#"[policy]
version = 2
[[policy.tool]]
name = "read_internal"
delta = { audience = ["internal"] }
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
                        cwd: None,
                    },
                    spawn: None,
                    prompt: None,
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

    /// A stored policy that already names one helper under two kinds restores
    /// without rewriting those bytes. The open trajectory keeps that document.
    #[tokio::test]
    async fn a_stored_cross_kind_helper_policy_restores_without_rewriting_it() {
        let stored = "\
[policy]
version = 2
[[policy.tool]]
name = \"mcp/github/get_file_contents\"
delta = {}
[externals.context.github]
url = \"http://127.0.0.1:9000/api/openappa/helpers/install-1/github\"
token_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"
[externals.audience.github]
url = \"http://127.0.0.1:9000/api/openappa/helpers/install-1/github\"
token_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"
";
        // SAFETY: the stored document names the bridge token; the host resolves
        // it at compile time and does not rewrite the policy bytes.
        unsafe { std::env::set_var("APPA_ARCHESTRA_BRIDGE_TOKEN", "bridge-token") };
        compile(stored).expect("stored bytes compile without being rewritten");
        let runtime = memory_runtime(stored);
        let opened = started(&runtime, "restored-cross-kind").await;
        assert!(matches!(
            hooks::handle(&runtime, call(&opened, "github__get_file_contents")).await,
            HookDecision::AllowCall { .. }
        ));
        runtime.reload(compile(stored).unwrap()).unwrap();
        assert!(
            matches!(
                hooks::handle(&runtime, call(&opened, "github__get_file_contents")).await,
                HookDecision::AllowCall { .. }
            ),
            "restoring the same bytes does not rewrite the open root"
        );
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
            target: None,
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
        // The stored bytes are a hosted document: they reload as they are, with the
        // host's result cap added.
        assert_eq!(
            reloaded_without_result_cap(&composed.content),
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
            target: None,
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
        // The composed bytes are a hosted document: they reload as they are, with the
        // host's result cap added.
        assert_eq!(reloaded_without_result_cap(&composed), composed);
        // An unbound helper keeps its command, which a hosted document refuses.
        let unbound = ResolvedBattery {
            helpers: None,
            ..battery()
        };
        assert!(compose(&root, &[unbound]).is_err());
    }

    #[test]
    fn a_target_composes_before_its_base_with_the_helpers_of_both_bound() {
        // SAFETY: as above.
        unsafe { std::env::set_var(BRIDGE_TOKEN_ENV, "bridge-token") };
        let url_base = "http://127.0.0.1:9000/api/openappa/helpers/install-1";
        let battery = || {
            ResolvedBattery {
            entry: GITHUB_ENTRY.into(),
            name: "github".into(),
            policy: "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/github/get_file_contents\"\ndelta = {}\n[externals.context.github]\ncommand = [\"python3\", \"context.py\"]\n".into(),
            target: Some("[policy]\nversion = 2\n[[policy.annotator]]\nname = \"github.visibility\"\nranks = [\"suspicious\"]\naudiences = [\"internal\"]\nmarks = []\n[[policy.tool]]\nname = \"mcp/github/list_issues\"\nannotator = \"github.visibility\"\n[externals.annotators.\"github.visibility\"]\ncommand = [\"python3\", \"visibility.py\"]\ntoken_env = \"APPA_PROVIDER_GITHUB_TOKEN\"\n".into()),
            helpers: Some(HelperBinding {
                url_base: url_base.into(),
                token_env: BRIDGE_TOKEN_ENV.into(),
            }),
        }
        };
        let root = format!(
            "include = [\"{GITHUB_ENTRY}\"]\n[server_aliases]\ngithub = [\"github_prod\"]\n[policy]\nversion = 2\n"
        );
        let composed = compose(&root, &[battery()]).unwrap().content;
        let document: toml::Table = toml::from_str(&composed).unwrap();
        for (section, name) in [("annotators", "github.visibility"), ("context", "github")] {
            let binding = &document["externals"][section][name];
            assert_eq!(
                binding["url"].as_str(),
                Some(format!("{url_base}/{name}").as_str())
            );
            assert_eq!(binding["token_env"].as_str(), Some(BRIDGE_TOKEN_ENV));
        }
        let rules: Vec<&str> = policy_entries(&document, "tool")
            .iter()
            .filter_map(|rule| rule.get("name")?.as_str())
            .collect();
        assert_eq!(
            rules,
            ["mcp/github/list_issues", "mcp/github/get_file_contents"]
        );
        // The base alone composes without the target's annotator.
        let base_only = compose(
            &root,
            &[ResolvedBattery {
                target: None,
                ..battery()
            }],
        )
        .unwrap()
        .content;
        let base_only: toml::Table = toml::from_str(&base_only).unwrap();
        assert!(policy_entries(&base_only, "annotator").is_empty());
    }

    /// The alias table is the root's own declaration now, not the host's insertion.
    #[test]
    fn a_helper_named_after_a_path_step_is_not_addressable() {
        // SAFETY: as above.
        unsafe { std::env::set_var(BRIDGE_TOKEN_ENV, "bridge-token") };
        let root = format!(
            "include = [\"{GITHUB_ENTRY}\"]\n[server_aliases]\ngithub = [\"github_prod\"]\n[policy]\nversion = 2\n"
        );
        for name in ["..", "."] {
            let battery = ResolvedBattery {
                entry: GITHUB_ENTRY.into(),
                name: "github".into(),
                policy: format!(
                    "[policy]\nversion = 2\n[[policy.annotator]]\nname = \"{name}\"\nranks = [\"suspicious\"]\naudiences = [\"internal\"]\nmarks = []\n[[policy.tool]]\nname = \"mcp/github/get_file_contents\"\nannotator = \"{name}\"\n[externals.annotators.\"{name}\"]\ncommand = [\"python3\", \"helper.py\"]\n"
                ),
                target: None,
                helpers: Some(HelperBinding {
                    url_base: "http://127.0.0.1:9000/api/openappa/helpers/install-1".into(),
                    token_env: BRIDGE_TOKEN_ENV.into(),
                }),
            };
            let error = compose(&root, &[battery]).unwrap_err();
            assert!(error.contains(&format!("{name:?}")), "{error}");
        }
    }

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
        for limit in ["0", "-1", "\"65536\""] {
            let invalid = format!("[policy]\nversion = 2\n[externals]\nmax_body_bytes = {limit}\n");
            assert!(validate(&invalid).is_err(), "{invalid}");
            assert!(compile(&invalid).is_err(), "{invalid}");
        }
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
        // A profile's key reaches its provider: never the host's own bearer.
        assert!(
            validate("[policy]\nversion = 2\n[externals.jev]\ntoken_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"\n")
                .is_err()
        );
        assert!(validate("[policy]\nversion = 2\n").is_ok());
        for policy in [
            "[policy]\nversion = 2\n[externals.authorities.review]\nurl = 'https://attacker.example/review'\ntoken_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"\n",
            "[policy]\nversion = 2\n[externals.authorities.review]\nurl = 'https://attacker.example/review'\n",
        ] {
            let battery = ResolvedBattery {
                entry: "batteries/acme/appa.toml".to_owned(),
                name: "acme".to_owned(),
                policy: policy.to_owned(),
                target: None,
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

    /// The jev battery ships its `[externals.jev]` profile: its key is granted to it, and
    /// the composed document names it among the credentials the runtime resolves itself,
    /// while a helper's own credential stays the sandbox's.
    #[test]
    fn the_jev_battery_composes_with_the_key_its_profile_names() {
        // SAFETY: as above.
        unsafe { std::env::set_var(BRIDGE_TOKEN_ENV, "bridge-token") };
        let jev = crate::batteries::bundled()
            .expect("bundled batteries validate")
            .iter()
            .find(|battery| battery.name == "jev")
            .expect("the jev battery is bundled");
        let github = ResolvedBattery {
            target: None,
            helpers: Some(HelperBinding {
                url_base: "http://127.0.0.1:9000/api/openappa/helpers/install-1".into(),
                token_env: BRIDGE_TOKEN_ENV.into(),
            }),
            policy: "[policy]\nversion = 2\n[[policy.annotator]]\nname = \"github.visibility\"\nranks = [\"suspicious\"]\naudiences = [\"internal\"]\nmarks = []\n[[policy.tool]]\nname = \"mcp/github/get_file_contents\"\nannotator = \"github.visibility\"\n[externals.annotators.\"github.visibility\"]\ncommand = [\"python3\", \"visibility.py\"]\ntoken_env = \"APPA_PROVIDER_GITHUB_TOKEN\"\n".into(),
            ..github_battery()
        };
        let root = format!(
            "include = [\"batteries/jev/appa.toml\", \"{GITHUB_ENTRY}\"]\n[server_aliases]\ngithub = [\"github_prod\"]\n[credentials]\nAPPA_PROVIDER_JEV_API_KEY = \"jev_key\"\nAPPA_PROVIDER_GITHUB_TOKEN = \"github_key\"\n[policy]\nversion = 2\n[[policy.tool]]\nname = \"read\"\nannotator = \"jev.tool-call\"\n"
        );
        let jev_battery = || ResolvedBattery {
            entry: "batteries/jev/appa.toml".into(),
            name: jev.name.clone(),
            policy: jev.base.clone(),
            target: None,
            helpers: None,
        };
        let composed = compose(&root, &[jev_battery(), github]).unwrap();
        let declarations = crate::declarations::parse(&composed.content);
        assert_eq!(
            declarations.runtime_credentials,
            ["APPA_PROVIDER_JEV_API_KEY"]
        );

        // A profile naming another battery's credential is not granted it.
        let foreign = ResolvedBattery {
            policy: jev
                .base
                .replace("APPA_PROVIDER_JEV_API_KEY", "APPA_PROVIDER_GITHUB_TOKEN"),
            ..jev_battery()
        };
        let root = "include = [\"batteries/jev/appa.toml\"]\n[policy]\nversion = 2\n";
        assert!(compose(root, &[jev_battery()]).is_ok());
        assert!(compose(root, &[foreign]).is_err());
    }

    #[test]
    fn keeps_declared_external_bindings() {
        let config = compile("[policy]\nversion = 2\n[externals.authorities.review]\nurl = 'https://example.com/review'\n").unwrap();
        assert!(
            String::from_utf8_lossy(config.policy_file().bytes())
                .contains("https://example.com/review")
        );
    }

    #[test]
    fn the_published_proxy_limit_is_the_host_default() {
        assert_eq!(parse_max_body_bytes(Some("73400320")), Some(73_400_320));
        assert_eq!(parse_max_body_bytes(Some(" 1048576 ")), Some(1_048_576));
    }

    #[test]
    fn no_host_default_without_a_usable_published_value() {
        for published in [None, Some(""), Some("0"), Some("-5"), Some("70MB")] {
            assert_eq!(parse_max_body_bytes(published), None);
        }
    }

    #[test]
    fn a_stated_body_limit_survives_compilation_composition_and_reload() {
        for limit in [4096, 65536, 999999999] {
            let stated = format!(
                "[policy]\nversion = 2\n[externals]\nmax_body_bytes = {limit}\ntimeout_ms = 1234\n"
            );
            let config = compile(&stated).unwrap();
            assert_eq!(config.externals.max_body_bytes, limit);
            assert_eq!(config.externals.timeout, Duration::from_millis(1234));
            let composed = compose(&stated, &[]).unwrap();
            let document: toml::Table = toml::from_str(&composed.content).unwrap();
            assert_eq!(
                document["externals"]["max_body_bytes"].as_integer(),
                Some(limit as i64)
            );
            let reloaded = compile(&composed.content).unwrap();
            assert_eq!(reloaded.externals.max_body_bytes, limit);
            assert_eq!(reloaded.externals.timeout, Duration::from_millis(1234));
        }
    }

    #[test]
    fn an_unstated_body_limit_uses_the_host_default_without_freezing_it_in_storage() {
        let content = "[policy]\nversion = 2\n";
        let unstated = compile(content).unwrap();
        assert_eq!(unstated.externals.max_body_bytes, host_max_body_bytes());
        let composed = compose(content, &[]).unwrap();
        let document: toml::Table = toml::from_str(&composed.content).unwrap();
        assert!(document["externals"].get("max_body_bytes").is_none());
        assert_eq!(
            compile(&composed.content).unwrap().externals.max_body_bytes,
            host_max_body_bytes()
        );
    }

    #[tokio::test]
    async fn an_explicit_limit_caps_carried_tool_results_by_utf8_bytes() {
        use appa_runtime_api::{OutcomeBody, ToolOutcome};

        let runtime = memory_runtime(
            "[policy]\nversion = 2\n[[policy.tool]]\nname = 'read'\ndelta = {}\n[externals]\nmax_body_bytes = 64\n",
        );
        let actor = started(&runtime, "body-cap").await;
        for output in [
            "x".repeat(64),
            "x".repeat(65),
            "\u{e9}".repeat(32),
            "\u{e9}".repeat(33),
        ] {
            let event = call(&actor, "read");
            assert!(matches!(
                hooks::handle(&runtime, event.clone()).await,
                HookDecision::AllowCall { .. }
            ));
            let HookEvent::ToolCall { call, call_id, .. } = event else {
                unreachable!();
            };
            let expected = if output.len() <= 64 {
                HookDecision::Ack
            } else {
                HookDecision::ReplaceOutput {
                    output: "[appa] the result was not carried; nothing was admitted".into(),
                }
            };
            assert_eq!(
                hooks::handle(
                    &runtime,
                    HookEvent::ToolResult {
                        actor: actor.clone(),
                        call,
                        call_id,
                        outcome: ToolOutcome::Success {
                            body: OutcomeBody::Available(output),
                        },
                    },
                )
                .await,
                expected
            );
        }
    }
}
