//! Battery packages as the host sees them: the ones bundled with the pinned
//! OpenAPPA checkout, and the ones an organization uploads, both read through the
//! same package validation the marketplace applies.
use crate::policy::{policy_entries, routed_annotators};
use appa_package::{MANIFEST_FILE, Role, bundled_batteries, validate_package};
use appa_runtime_api::CanonicalTool;
use std::{path::Component, sync::OnceLock};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BatteryFile {
    pub path: String,
    pub text: String,
}

/// One `[externals.<kind>.<name>]` binding a battery runs as a command, with the
/// provider variable the command reads its credential from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct HelperExternal {
    pub kind: String,
    pub name: String,
    pub command: Vec<String>,
    pub token_env: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BatteryInfo {
    pub name: String,
    pub description: String,
    pub namespaces: Vec<String>,
    pub annotators: Vec<String>,
    /// The annotators its own tool rules route calls to.
    pub routed_annotators: Vec<String>,
    pub policy: String,
    pub helpers: Vec<String>,
    pub credentials: Vec<String>,
    pub externals: Vec<HelperExternal>,
    pub setup: Option<String>,
    pub files: Vec<BatteryFile>,
}

/// Every bundled battery this host serves, inspected once per process.
/// A bundle that fails validation is an error naming that battery, not a panic.
pub(crate) fn bundled() -> Result<&'static [BatteryInfo], String> {
    static BUNDLED: OnceLock<Result<Vec<BatteryInfo>, String>> = OnceLock::new();
    match BUNDLED.get_or_init(load_bundled) {
        Ok(batteries) => Ok(batteries),
        Err(error) => Err(error.clone()),
    }
}

fn load_bundled() -> Result<Vec<BatteryInfo>, String> {
    let mut batteries = bundled_batteries()
        .iter()
        .filter(|battery| match battery.manifest() {
            Ok(package) => match &package.role {
                Role::Battery(declared) => battery
                    .file(declared.policy.as_str())
                    .and_then(|policy| toml::from_str::<toml::Table>(policy).ok())
                    .is_none_or(|document| serves_this_host(&document)),
                Role::Plugin(_) => false,
            },
            Err(_) => true,
        })
        .map(|battery| {
            let files = battery
                .files
                .iter()
                .map(|file| BatteryFile {
                    path: file.path.to_owned(),
                    text: file.text.to_owned(),
                })
                .collect::<Vec<_>>();
            inspect(&files).map_err(|error| {
                format!(
                    "bundled battery {} does not validate: {error}",
                    battery.name
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    for package in host_packages() {
        let info = inspect(&package.files)
            .map_err(|error| format!("host battery {} does not validate: {error}", package.name))?;
        if info.name != package.name {
            return Err(format!(
                "host battery {} validated as {}",
                package.name, info.name
            ));
        }
        if batteries.iter().any(|battery| battery.name == info.name) {
            return Err(format!(
                "host battery {} collides with a pinned marketplace battery",
                info.name
            ));
        }
        batteries.push(info);
    }
    batteries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(batteries)
}

/// A package this host ships beside the pinned marketplace. It is not a raw
/// policy string: [`inspect`] writes the files and runs `validate_package`.
struct HostPackage {
    name: &'static str,
    files: Vec<BatteryFile>,
}

fn host_packages() -> Vec<HostPackage> {
    vec![HostPackage {
        name: "gmail",
        files: gmail_files(),
    }]
}

fn gmail_files() -> Vec<BatteryFile> {
    vec![
        BatteryFile {
            path: MANIFEST_FILE.to_owned(),
            text: include_str!("../batteries/gmail/appa-package.toml").to_owned(),
        },
        BatteryFile {
            path: "appa.toml".to_owned(),
            text: include_str!("../batteries/gmail/appa.toml").to_owned(),
        },
    ]
}

/// Validate a battery package from its files and read what the host needs from it.
/// Runs the marketplace's own package validation on a scratch copy, so an uploaded
/// package passes exactly the checks a bundled one passed.
pub(crate) fn inspect(files: &[BatteryFile]) -> Result<BatteryInfo, String> {
    let dir = tempfile::tempdir().map_err(|error| error.to_string())?;
    for file in files {
        let relative = std::path::Path::new(&file.path);
        if relative.as_os_str().is_empty()
            || !relative
                .components()
                .all(|component| matches!(component, Component::Normal(_)))
        {
            return Err(format!(
                "package file path {:?} is not a relative path",
                file.path
            ));
        }
        let target = dir.path().join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::write(&target, &file.text).map_err(|error| error.to_string())?;
    }
    let package = validate_package(dir.path()).map_err(|error| error.to_string())?;
    let Role::Battery(battery) = &package.role else {
        return Err(format!(
            "package {} is a plugin, not a battery",
            package.name
        ));
    };
    let policy_path = battery.policy.as_str();
    let policy = files
        .iter()
        .find(|file| file.path == policy_path)
        .map(|file| file.text.clone())
        .ok_or_else(|| {
            format!(
                "battery {} names a policy file it does not carry",
                package.name
            )
        })?;
    let document: toml::Table = toml::from_str(&policy).map_err(|error| error.to_string())?;
    if !serves_this_host(&document) {
        return Err(format!(
            "battery {} governs no MCP tool and is not an annotator-only battery, so this host has nothing for it to govern",
            package.name
        ));
    }
    Ok(BatteryInfo {
        name: package.name.to_string(),
        description: package.description.clone(),
        // The manifest defaults a battery's namespace to its own name; one without a
        // tool rule governs no namespace, so no server alias points it anywhere.
        namespaces: if policy_entries(&document, "tool").is_empty() {
            Vec::new()
        } else {
            battery.namespaces.iter().map(ToString::to_string).collect()
        },
        annotators: annotator_names(&document),
        routed_annotators: routed_annotators(&document),
        externals: helper_externals(&document)?,
        policy,
        helpers: battery.helpers.iter().map(ToString::to_string).collect(),
        credentials: battery.credentials.clone(),
        setup: (!battery.setup.is_empty()).then(|| battery.setup.join("\n")),
        files: files.to_vec(),
    })
}

/// Whether a battery has anything to say under this host: a rule names an MCP tool,
/// the only kind of tool Archestra serves, or it declares no tool rule and only
/// annotators, which a root rule routes a tool to by name. A battery written for
/// another host's own tools composes but never matches here, so it is not offered.
fn serves_this_host(document: &toml::Table) -> bool {
    let rules = policy_entries(document, "tool");
    let governs_mcp_tools = rules.iter().any(|rule| {
        rule.get("name")
            .and_then(toml::Value::as_str)
            .is_some_and(governs_an_mcp_tool)
    });
    governs_mcp_tools || (rules.is_empty() && !annotator_names(document).is_empty())
}

fn annotator_names(document: &toml::Table) -> Vec<String> {
    policy_entries(document, "annotator")
        .iter()
        .filter_map(|annotator| annotator.get("name").and_then(toml::Value::as_str))
        .map(str::to_owned)
        .collect()
}

/// Whether a rule's name before its selector, as the runtime reads it, is a canonical
/// `mcp/<catalog>/<tool>` identity. The marketplace keeps every battery rule inside the
/// namespaces it declares, so a wildcard never reaches here.
fn governs_an_mcp_tool(name: &str) -> bool {
    let bare = name.split_once('(').map_or(name, |(bare, _)| bare);
    CanonicalTool::parse(bare).is_ok_and(|tool| tool.as_str().starts_with("mcp/"))
}

fn helper_externals(document: &toml::Table) -> Result<Vec<HelperExternal>, String> {
    crate::policy::refuse_host_variables(document)?;
    crate::policy::refuse_url_externals(document)?;
    let mut externals: Vec<HelperExternal> = Vec::new();
    for (kind, name, entry) in crate::policy::external_bindings(document) {
        let Some(command) = entry.get("command").and_then(toml::Value::as_array) else {
            continue;
        };
        // The same name may serve two kinds. The consult body names the kind,
        // and the helper bridge uses that to pick the command. The same kind
        // and name twice is still one binding pretending to be two.
        if externals
            .iter()
            .any(|external| external.kind == kind && external.name == name)
        {
            return Err(format!(
                "external {name:?} is declared twice under {kind}; a kind names each helper once"
            ));
        }
        externals.push(HelperExternal {
            kind: kind.to_owned(),
            name: name.to_owned(),
            command: command
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::to_owned)
                .collect(),
            token_env: entry
                .get("token_env")
                .and_then(toml::Value::as_str)
                .map(str::to_owned),
        });
    }
    Ok(externals)
}

#[cfg(test)]
mod tests {
    use super::*;
    use appa_package::MANIFEST_FILE;

    #[test]
    fn the_bundled_github_battery_is_served_with_its_helpers_and_credential() {
        let github = bundled()
            .expect("bundled batteries validate")
            .iter()
            .find(|battery| battery.name == "github")
            .expect("the github battery governs MCP tools");
        assert_eq!(
            github.credentials,
            vec!["APPA_PROVIDER_GITHUB_TOKEN".to_owned()]
        );
        assert!(
            github
                .routed_annotators
                .iter()
                .any(|annotator| annotator == "github.repository-visibility")
        );
        assert!(
            github
                .helpers
                .iter()
                .any(|helper| helper == "repository-visibility.py")
        );
        assert!(github.externals.iter().any(|external| {
            external.kind == "annotators"
                && external.name == "github.repository-visibility"
                && external.token_env.as_deref() == Some("APPA_PROVIDER_GITHUB_TOKEN")
        }));
        assert!(
            github
                .externals
                .iter()
                .any(|external| { external.kind == "context" && external.name == "github" })
        );
        assert!(
            github
                .externals
                .iter()
                .any(|external| { external.kind == "audience" && external.name == "github" })
        );
        assert!(github.files.iter().any(|file| file.path == MANIFEST_FILE));
        assert!(
            bundled()
                .expect("bundled batteries validate")
                .iter()
                .all(|battery| battery.name != "claude-code")
        );
    }

    #[test]
    fn the_bundled_jev_battery_is_served_as_annotators_alone() {
        let jev = bundled()
            .expect("bundled batteries validate")
            .iter()
            .find(|battery| battery.name == "jev")
            .expect("an annotator-only battery is served");
        assert!(jev.namespaces.is_empty());
        assert_eq!(jev.annotators, vec!["jev.tool-call".to_owned()]);
        // A battery with no tool rule routes nothing to its own annotator.
        assert!(jev.routed_annotators.is_empty());
        assert_eq!(
            jev.credentials,
            vec!["APPA_PROVIDER_JEV_API_KEY".to_owned()]
        );
        // The runtime asks Jev itself: the battery ships no helper to run.
        assert!(jev.helpers.is_empty());
        assert!(jev.externals.is_empty());
    }

    #[test]
    fn an_uploaded_annotator_only_package_is_served_unless_it_names_another_hosts_tools() {
        let manifest = "schema = 1\nname = \"tagger\"\ndescription = \"Tags calls\"\n[battery]\npolicy = \"appa.toml\"\nhosts = [\"claude-code\"]\nhelpers = [\"tag.py\"]\n";
        let annotator = "[policy]\nversion = 2\n[[policy.annotator]]\nname = \"tagger.call\"\nranks = [\"suspicious\", \"trusted\"]\naudiences = [\"self\"]\nmarks = []\n[externals.annotators.\"tagger.call\"]\ncommand = [\"python3\", \"tag.py\"]\n";
        let files = |policy: String| {
            vec![
                BatteryFile {
                    path: MANIFEST_FILE.to_owned(),
                    text: manifest.to_owned(),
                },
                BatteryFile {
                    path: "appa.toml".to_owned(),
                    text: policy,
                },
                BatteryFile {
                    path: "tag.py".to_owned(),
                    text: "print('{}')\n".to_owned(),
                },
            ]
        };
        let info = inspect(&files(annotator.to_owned())).unwrap();
        assert!(info.namespaces.is_empty());
        assert_eq!(info.annotators, vec!["tagger.call".to_owned()]);
        assert!(
            inspect(&files(format!(
                "{annotator}[[policy.tool]]\nname = \"host/claude-code/Bash\"\ndelta = {{}}\n"
            )))
            .is_err()
        );
        assert!(
            inspect(&files(format!(
                "{annotator}token_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"\n"
            )))
            .is_err()
        );
        let shared = inspect(&files(format!(
            "{annotator}[externals.authorities.\"tagger.call\"]\ncommand = [\"python3\", \"tag.py\"]\n"
        )))
        .expect("two kinds may use the same packaged helper");
        assert_eq!(shared.externals.len(), 2);
        for kind in ["annotators", "authorities"] {
            assert!(shared.externals.iter().any(|external| {
                external.kind == kind
                    && external.name == "tagger.call"
                    && external.command == ["python3", "tag.py"]
            }));
        }
        assert!(
            inspect(&files(
                "[policy]\nversion = 2\n[externals.annotators.\"tagger.call\"]\ncommand = [\"python3\", \"tag.py\"]\n".to_owned()
            ))
            .is_err()
        );
    }

    #[test]
    fn an_uploaded_package_passes_the_marketplace_checks_or_is_refused() {
        let manifest = "schema = 1\nname = \"acme\"\ndescription = \"Acme rules\"\n[battery]\npolicy = \"appa.toml\"\nhosts = [\"claude-code\"]\nnamespaces = [\"acme\"]\n";
        let policy =
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme/list\"\ndelta = {}\n";
        let files = || {
            vec![
                BatteryFile {
                    path: MANIFEST_FILE.to_owned(),
                    text: manifest.to_owned(),
                },
                BatteryFile {
                    path: "appa.toml".to_owned(),
                    text: policy.to_owned(),
                },
            ]
        };
        let info = inspect(&files()).unwrap();
        assert_eq!(info.name, "acme");
        assert!(info.credentials.is_empty());
        assert!(inspect(&files()[1..]).is_err());
        let mut escaping = files();
        escaping[1].path = "../appa.toml".to_owned();
        assert!(inspect(&escaping).is_err());
        let mut foreign = files();
        foreign[1].text =
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/other/list\"\ndelta = {}\n"
                .to_owned();
        assert!(inspect(&foreign).is_err());
        let mut another_hosts_tools = files();
        another_hosts_tools[1].text =
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"host/claude-code/Bash\"\ndelta = {}\n"
                .to_owned();
        assert!(inspect(&another_hosts_tools).is_err());
        let mut no_identity = files();
        no_identity[1].text =
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme\"\ndelta = {}\n".to_owned();
        assert!(inspect(&no_identity).is_err());
        let mut selected = files();
        selected[1].text =
            "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme/list(path:private*)\"\ndelta = {}\n"
                .to_owned();
        assert!(inspect(&selected).is_ok());
        let mut same_name = files();
        same_name[0]
            .text
            .push_str("helpers = [\"a.py\", \"b.py\"]\n");
        same_name.extend(["a.py", "b.py"].map(|path| BatteryFile {
            path: path.to_owned(),
            text: "print('{}')\n".to_owned(),
        }));
        same_name[1].text = "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme/list\"\ndelta = {}\n[externals.annotators.foo]\ncommand = [\"python3\", \"a.py\"]\n[externals.authorities.foo]\ncommand = [\"python3\", \"b.py\"]\n".to_owned();
        let same = inspect(&same_name).expect("two kinds may share a helper name");
        assert_eq!(same.externals.len(), 2);
        for (kind, helper) in [("annotators", "a.py"), ("authorities", "b.py")] {
            assert!(same.externals.iter().any(|external| {
                external.kind == kind
                    && external.name == "foo"
                    && external.command == ["python3", helper]
            }));
        }
        same_name[1].text = "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme/list\"\ndelta = {}\n[externals.annotators.foo]\ncommand = [\"python3\", \"a.py\"]\n[externals.annotators.foo]\ncommand = [\"python3\", \"b.py\"]\n".to_owned();
        assert!(inspect(&same_name).is_err());
        let mut host_variable = files();
        host_variable[1].text = "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme/list\"\ndelta = {}\n[externals.authorities.review]\ncommand = [\"python3\", \"review.py\"]\ntoken_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"\n".to_owned();
        assert!(inspect(&host_variable).is_err());
        let mut remote = files();
        remote[1].text = "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme/list\"\ndelta = {}\n[externals.authorities.review]\nurl = \"https://attacker.example/review\"\n".to_owned();
        assert!(inspect(&remote).is_err());
    }

    #[test]
    fn the_host_gmail_package_validates_and_is_not_the_drive_battery() {
        assert!(
            bundled_batteries()
                .iter()
                .all(|battery| battery.name != "gmail"),
            "gmail must stay a host package; the pinned checkout does not ship it"
        );
        let gmail = inspect(&gmail_files()).expect("the host package validates");
        assert_eq!(gmail.name, "gmail");
        assert_eq!(gmail.namespaces, vec!["gmail".to_owned()]);
        assert!(gmail.helpers.is_empty());
        assert!(gmail.credentials.is_empty());
        assert!(gmail.externals.is_empty());
        let served = bundled().expect("bundled batteries validate");
        assert!(served.iter().any(|battery| battery.name == "gmail"));
        let drive = served
            .iter()
            .find(|battery| battery.name == "google-workspace")
            .expect("the pinned drive battery is still served");
        assert!(
            !drive.policy.contains("search_threads"),
            "the drive battery must not be treated as gmail coverage"
        );
        let document: toml::Table = toml::from_str(&gmail.policy).unwrap();
        let names: Vec<&str> = policy_entries(&document, "tool")
            .iter()
            .map(|rule| rule.get("name").and_then(toml::Value::as_str).unwrap())
            .collect();
        assert_eq!(
            names,
            vec![
                "mcp/gmail/search_threads",
                "mcp/gmail/get_thread",
                "mcp/gmail/get_message",
                "mcp/gmail/list_drafts",
                "mcp/gmail/list_labels",
                "mcp/gmail/create_draft",
                "mcp/gmail/create_label",
                "mcp/gmail/label_message",
                "mcp/gmail/label_thread",
                "mcp/gmail/unlabel_message",
                "mcp/gmail/unlabel_thread",
                "mcp/gmail/apply_sensitive_message_label",
                "mcp/gmail/apply_sensitive_thread_label",
            ]
        );
        assert!(names.iter().all(|name| !name.contains('*')));
        assert!(names.iter().all(|name| !name.contains("send")));
        let policy_without_comments = gmail
            .policy
            .lines()
            .filter(|line| !line.trim_start().starts_with('#'))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(!policy_without_comments.contains("$to"));
        assert!(!policy_without_comments.contains("$cc"));
        assert!(!policy_without_comments.contains("$bcc"));
        let draft = policy_entries(&document, "tool")
            .iter()
            .find(|rule| {
                rule.get("name").and_then(toml::Value::as_str) == Some("mcp/gmail/create_draft")
            })
            .unwrap();
        assert_eq!(
            draft.get("effects").and_then(toml::Value::as_array),
            Some(&vec![toml::Value::String("gmail.drafted".to_owned())])
        );
        assert_eq!(
            draft
                .get("delta")
                .and_then(toml::Value::as_table)
                .and_then(|delta| delta.get("trust"))
                .and_then(toml::Value::as_str),
            Some("suspicious"),
            "a draft result can echo mailbox text"
        );
        let created = policy_entries(&document, "tool")
            .iter()
            .find(|rule| {
                rule.get("name").and_then(toml::Value::as_str) == Some("mcp/gmail/create_label")
            })
            .unwrap();
        assert!(
            created
                .get("delta")
                .and_then(toml::Value::as_table)
                .is_some_and(|delta| delta.get("trust").is_none()),
            "create_label has no message or reply argument to echo"
        );
    }

    #[tokio::test]
    async fn a_gmail_read_narrows_and_an_unsafe_write_is_denied() {
        use appa_eventlog::{Backend, LogStore};
        use appa_runtime::api::{AuditEvent, AuditLabel, RemedyOutcome};
        use appa_runtime::hooks;
        use appa_runtime_api::{
            Actor, HookDecision, HookEvent, OutcomeBody, ProposedCall, ToolOutcome, TrajectoryId,
        };
        use std::sync::Arc;
        use std::sync::atomic::{AtomicU64, Ordering};

        let gmail = bundled()
            .expect("bundled batteries validate")
            .iter()
            .find(|battery| battery.name == "gmail")
            .expect("the host gmail package is served")
            .clone();
        let composed = crate::policy::compose(
            "include = [\"batteries/gmail/appa.toml\"]\n[server_aliases]\ngmail = [\"gmail_prod\"]\n[policy]\nversion = 2\n",
            &[crate::policy::ResolvedBattery {
                entry: "batteries/gmail/appa.toml".into(),
                name: gmail.name,
                policy: gmail.policy,
                helpers: None,
            }],
        )
        .expect("the gmail package composes without a catchall");
        assert!(
            !composed.content.contains("name = \"*\""),
            "the composed document must not add a catchall"
        );
        let runtime = crate::policy::open(
            crate::policy::compile(&composed.content, |var| {
                (var == "APPA_ARCHESTRA_BRIDGE_TOKEN").then(|| "gmail-test-bridge-token".to_owned())
            })
            .unwrap(),
            Arc::new(LogStore::open(Backend::Memory).unwrap()),
        )
        .unwrap();

        fn proposed(tool: &str, arguments: serde_json::Value) -> (String, ProposedCall) {
            static CALLS: AtomicU64 = AtomicU64::new(0);
            let call_id = format!("call:{}", CALLS.fetch_add(1, Ordering::Relaxed));
            let call = ProposedCall {
                tool: (crate::adapter::adapter().identify_tool)(tool)
                    .expect("test tool names are well formed")
                    .canonical
                    .as_str()
                    .to_owned(),
                arguments: serde_json::value::RawValue::from_string(arguments.to_string()).unwrap(),
                cwd: None,
            };
            (call_id, call)
        }
        fn event(actor: &Actor, call_id: &str, call: ProposedCall) -> HookEvent {
            HookEvent::ToolCall {
                call_id: Some(call_id.to_owned()),
                actor: actor.clone(),
                call,
                spawn: None,
                prompt: None,
                ruling: None,
            }
        }
        async fn accept(
            runtime: &appa_runtime::api::Runtime,
            actor: &Actor,
            decision: &HookDecision,
        ) {
            let HookDecision::DenyCall {
                offers, feedback, ..
            } = decision
            else {
                panic!("expected a deny that offers a narrowing, got {decision:?}");
            };
            let Some(offer) = offers.first() else {
                panic!("deny carried no offer: {feedback}");
            };
            let result = runtime
                .execute_remedy(actor, appa_runtime::api::OfferId(offer.id.clone()))
                .await;
            assert!(
                !matches!(result, RemedyOutcome::Refused { .. }),
                "{result:?}"
            );
        }
        async fn admit(
            runtime: &appa_runtime::api::Runtime,
            actor: &Actor,
            call_id: &str,
            call: ProposedCall,
        ) {
            assert_eq!(
                hooks::handle(
                    runtime,
                    HookEvent::ToolResult {
                        actor: actor.clone(),
                        call,
                        call_id: Some(call_id.to_owned()),
                        outcome: ToolOutcome::Success {
                            body: OutcomeBody::Available("mailbox".into()),
                        },
                    },
                )
                .await,
                HookDecision::Ack
            );
        }

        async fn started(runtime: &appa_runtime::api::Runtime, root: &str) -> Actor {
            let actor = Actor {
                root: TrajectoryId(root.into()),
                child: None,
            };
            assert_eq!(
                hooks::handle(
                    runtime,
                    HookEvent::SessionStart {
                        root: actor.root.clone(),
                        principal: None,
                        address: None,
                        title: None,
                    },
                )
                .await,
                HookDecision::Ack
            );
            let opened = runtime.status(&actor.root).expect("the session opened");
            assert_eq!(
                opened.trust, "trusted",
                "a fresh session is not already low-trust"
            );
            actor
        }
        fn admitted(runtime: &appa_runtime::api::Runtime, actor: &Actor) -> Vec<AuditLabel> {
            runtime
                .audit(&actor.root)
                .unwrap()
                .into_iter()
                .filter_map(|entry| match entry.event {
                    AuditEvent::Admitted { label } => Some(label),
                    _ => None,
                })
                .collect()
        }

        let reader = started(&runtime, "gmail-read").await;
        assert!(admitted(&runtime, &reader).is_empty());
        let (read_id, read) = proposed(
            "gmail_prod__get_message",
            serde_json::json!({ "messageId": "m1", "messageFormat": "full" }),
        );
        let narrowing = hooks::handle(&runtime, event(&reader, &read_id, read)).await;
        let HookDecision::DenyCall { feedback, .. } = &narrowing else {
            panic!("a fresh trusted read must not run: {narrowing:?}");
        };
        assert!(
            feedback.contains("session trust would fall: trusted -> suspicious"),
            "the read itself must lower a fresh trusted session: {feedback}"
        );
        assert!(
            feedback.contains("allowed readers would narrow: public -> a symbolic audience"),
            "the read itself must narrow a fresh public session: {feedback}"
        );
        assert_eq!(
            runtime
                .status(&reader.root)
                .expect("the denied read leaves the session")
                .trust,
            "trusted",
            "the denied read must not apply its low label"
        );
        assert!(admitted(&runtime, &reader).is_empty());

        let drafter = started(&runtime, "gmail-draft").await;
        let (draft_id, draft) = proposed(
            "gmail_prod__create_draft",
            serde_json::json!({
                "to": ["someone@example.com"],
                "cc": ["other@example.com"],
                "bcc": ["hidden@example.com"],
                "subject": "not sent",
                "body": "still a draft",
                "replyToMessageId": "m1"
            }),
        );
        let first = hooks::handle(&runtime, event(&drafter, &draft_id, draft.clone())).await;
        let HookDecision::DenyCall {
            feedback: draft_feedback,
            ..
        } = &first
        else {
            panic!("a fresh draft must not run as a send: {first:?}");
        };
        assert!(
            draft_feedback.contains("session trust would fall: trusted -> suspicious"),
            "a draft result is untrusted mailbox text: {draft_feedback}"
        );
        assert!(
            draft_feedback.contains("allowed readers would narrow: public -> a symbolic audience"),
            "a draft narrows to the session principal, not its recipients: {draft_feedback}"
        );
        assert!(
            !draft_feedback.contains("example.com"),
            "draft recipients are not required readers: {draft_feedback}"
        );
        assert_eq!(
            runtime
                .status(&drafter.root)
                .expect("the denied draft leaves the session")
                .trust,
            "trusted"
        );

        let labeler = started(&runtime, "gmail-label").await;
        let (label_id, label) = proposed(
            "gmail_prod__create_label",
            serde_json::json!({ "name": "caller-named" }),
        );
        let label_deny = hooks::handle(&runtime, event(&labeler, &label_id, label.clone())).await;
        accept(&runtime, &labeler, &label_deny).await;
        assert!(matches!(
            hooks::handle(&runtime, event(&labeler, &label_id, label.clone())).await,
            HookDecision::AllowCall { .. }
        ));
        admit(&runtime, &labeler, &label_id, label).await;
        assert_eq!(
            admitted(&runtime, &labeler),
            vec![AuditLabel {
                trust: "trusted".to_owned(),
                audience: "self".to_owned(),
            }],
            "create_label echoes the caller's name and does not lower trust"
        );
        for tool in ["gmail_prod__create_draft", "gmail_prod__label_message"] {
            let (call_id, call) = proposed(
                tool,
                serde_json::json!({
                    "to": ["someone@example.com"],
                    "replyToMessageId": "m1"
                }),
            );
            let denied = hooks::handle(&runtime, event(&labeler, &call_id, call)).await;
            let HookDecision::DenyCall { feedback, .. } = &denied else {
                panic!("{tool} must not run after a trusted label: {denied:?}");
            };
            assert!(
                feedback.contains("session trust would fall: trusted -> suspicious"),
                "{tool} must treat its result as untrusted: {feedback}"
            );
            assert!(
                !feedback.contains("example.com"),
                "{tool} must not treat draft recipients as readers: {feedback}"
            );
        }
        assert_eq!(
            runtime
                .status(&labeler.root)
                .expect("the denied writes leave the session")
                .trust,
            "trusted"
        );
        assert_eq!(
            admitted(&runtime, &labeler),
            vec![AuditLabel {
                trust: "trusted".to_owned(),
                audience: "self".to_owned(),
            }]
        );
        let released: Vec<Vec<String>> = runtime
            .audit(&labeler.root)
            .unwrap()
            .into_iter()
            .filter_map(|entry| match entry.event {
                AuditEvent::Released { effects, .. } => Some(effects),
                _ => None,
            })
            .collect();
        assert_eq!(released, vec![vec!["gmail.labeled".to_owned()]]);
        assert!(
            released
                .iter()
                .flatten()
                .all(|effect| !effect.contains("sent"))
        );

        for tool in [
            "gmail_prod__send_message",
            "gmail_prod__not_a_tool",
            "other__get_message",
        ] {
            let (call_id, call) = proposed(tool, serde_json::json!({}));
            let decision = hooks::handle(&runtime, event(&reader, &call_id, call)).await;
            assert!(
                matches!(decision, HookDecision::Refuse { .. }),
                "{tool} must be undeclared, not covered: {decision:?}"
            );
        }
    }
}
