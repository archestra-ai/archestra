//! Battery packages as the host sees them: the ones bundled with the pinned
//! OpenAPPA checkout, and the ones an organization uploads, both read through the
//! same package validation the marketplace applies.
use crate::policy::{policy_entries, routed_annotators};
use appa_package::{BatteryTarget, Role, bundled_batteries, validate_package};
use appa_runtime_api::CanonicalTool;
use std::{collections::BTreeSet, path::Component, sync::OnceLock};

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
    /// The base policy: all a deployment without a target composes.
    pub base: String,
    pub helpers: Vec<String>,
    pub credentials: Vec<String>,
    pub externals: Vec<HelperExternal>,
    pub benefit: Option<String>,
    pub setup: Option<String>,
    pub files: Vec<BatteryFile>,
    /// What a multi-user deployment composes, when the battery declares targets.
    pub multi_user: Option<BatteryTargetInfo>,
}

/// A battery deployed for its multi-user target: the target policy, composed before
/// the base, and what the two declare and read together.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct BatteryTargetInfo {
    pub policy: String,
    pub credentials: Vec<String>,
    /// The variables the target policy itself reads, without the base's.
    pub target_credentials: Vec<String>,
    pub externals: Vec<HelperExternal>,
    pub annotators: Vec<String>,
    pub routed_annotators: Vec<String>,
    pub setup: Option<String>,
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
    bundled_batteries()
        .iter()
        .filter(|battery| match battery.manifest() {
            Ok(package) => match &package.role {
                Role::Battery(declared) => {
                    let document = |path: &str| {
                        battery
                            .file(path)
                            .and_then(|policy| toml::from_str::<toml::Table>(policy).ok())
                    };
                    let target = declared
                        .targets
                        .as_ref()
                        .and_then(|targets| document(targets.multi_user.policy.as_str()));
                    document(declared.base.as_str())
                        .is_none_or(|base| serves_this_host(&base, target.as_ref()))
                }
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
        .collect()
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
    let policy = |path: &str| -> Result<(String, toml::Table), String> {
        let text = files
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.text.clone())
            .ok_or_else(|| {
                format!(
                    "battery {} names a policy file {path} it does not carry",
                    package.name
                )
            })?;
        let document = toml::from_str(&text).map_err(|error| error.to_string())?;
        Ok((text, document))
    };
    let (base, document) = policy(battery.base.as_str())?;
    let target = battery
        .targets
        .as_ref()
        .map(|targets| policy(targets.multi_user.policy.as_str()))
        .transpose()?;
    let target_document = target.as_ref().map(|(_, document)| document);
    if !serves_this_host(&document, target_document) {
        return Err(format!(
            "battery {} governs no MCP tool and is not an annotator-only battery, so this host has nothing for it to govern",
            package.name
        ));
    }
    // The manifest defaults a battery's namespace to its own name; one without a
    // tool rule in any policy it deploys governs no namespace, so no server alias
    // points it anywhere.
    let governs_tools = std::iter::once(&document)
        .chain(target_document)
        .any(|document| !policy_entries(document, "tool").is_empty());
    let externals = helper_externals(&document)?;
    let multi_user = match target {
        None => None,
        Some((policy, target)) => Some(BatteryTargetInfo {
            target_credentials: battery
                .targets
                .as_ref()
                .map(|targets| targets.multi_user.credentials.clone())
                .unwrap_or_default(),
            externals: [helper_externals(&target)?, externals.clone()].concat(),
            annotators: [annotator_names(&target), annotator_names(&document)].concat(),
            routed_annotators: [routed_annotators(&target), routed_annotators(&document)]
                .concat()
                .into_iter()
                .collect::<BTreeSet<_>>()
                .into_iter()
                .collect(),
            credentials: battery
                .credentials_for(BatteryTarget::MultiUser)
                .into_iter()
                .map(str::to_owned)
                .collect(),
            setup: setup_text(battery.setup_steps(BatteryTarget::MultiUser)),
            policy,
        }),
    };
    Ok(BatteryInfo {
        name: package.name.to_string(),
        description: package.description.clone(),
        namespaces: if governs_tools {
            battery.namespaces.iter().map(ToString::to_string).collect()
        } else {
            Vec::new()
        },
        annotators: annotator_names(&document),
        routed_annotators: routed_annotators(&document),
        externals,
        base,
        helpers: battery.helpers.iter().map(ToString::to_string).collect(),
        credentials: battery.credentials.clone(),
        benefit: battery.benefit.clone(),
        setup: setup_text(&battery.setup),
        files: files.to_vec(),
        multi_user,
    })
}

/// The host reads setup steps as one line each, joined; none is no setup.
fn setup_text(steps: &[String]) -> Option<String> {
    (!steps.is_empty()).then(|| steps.join("\n"))
}

/// Whether a battery has anything to say under this host: a rule names an MCP tool,
/// the only kind of tool Archestra serves, or it declares no tool rule and only
/// annotators, which a root rule routes a tool to by name. A battery written for
/// another host's own tools composes but never matches here, so it is not offered.
/// A multi-user target is read together with its base, as the two deploy.
fn serves_this_host(base: &toml::Table, target: Option<&toml::Table>) -> bool {
    let documents = || std::iter::once(base).chain(target);
    let rules: Vec<&toml::Value> = documents()
        .flat_map(|document| policy_entries(document, "tool"))
        .collect();
    let governs_mcp_tools = rules.iter().any(|rule| {
        rule.get("name")
            .and_then(toml::Value::as_str)
            .is_some_and(governs_an_mcp_tool)
    });
    governs_mcp_tools
        || (rules.is_empty() && documents().any(|document| !annotator_names(document).is_empty()))
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
    fn the_bundled_github_battery_serves_its_helpers_and_credential_through_its_multi_user_target()
    {
        let github = bundled()
            .expect("bundled batteries validate")
            .iter()
            .find(|battery| battery.name == "github")
            .expect("the github battery governs MCP tools");
        // The base alone reads no credential and runs no helper.
        assert!(github.credentials.is_empty());
        assert!(github.externals.is_empty());
        assert!(github.routed_annotators.is_empty());
        assert_eq!(github.namespaces, vec!["github".to_owned()]);
        let target = github
            .multi_user
            .as_ref()
            .expect("the github battery declares targets");
        assert_ne!(target.policy, github.base);
        assert_eq!(
            target.credentials,
            vec!["APPA_PROVIDER_GITHUB_TOKEN".to_owned()]
        );
        assert!(
            target
                .routed_annotators
                .iter()
                .any(|annotator| annotator == "github.repository-visibility")
        );
        assert!(
            target
                .annotators
                .iter()
                .any(|annotator| annotator == "github.repository-visibility")
        );
        for (kind, name, helper) in [
            (
                "annotators",
                "github.repository-visibility",
                "repository-visibility-multi-user.py",
            ),
            ("context", "github", "context-multi-user.py"),
            ("audience", "github", "audience-source-multi-user.py"),
        ] {
            assert!(target.externals.iter().any(|external| {
                external.kind == kind
                    && external.name == name
                    && external.command.last().map(String::as_str) == Some(helper)
                    && external.token_env.as_deref() == Some("APPA_PROVIDER_GITHUB_TOKEN")
            }));
            assert!(github.helpers.iter().any(|packaged| packaged == helper));
        }
        assert_ne!(target.setup, github.setup);
        assert!(target.setup.is_some());
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
        assert!(jev.multi_user.is_none());
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
    fn an_uploaded_package_governs_the_tools_its_multi_user_target_names() {
        let manifest = "schema = 1\nname = \"acme\"\ndescription = \"Acme rules\"\n[battery]\npolicy = \"appa.toml\"\nhosts = [\"kagent\"]\nnamespaces = [\"acme\"]\nhelpers = [\"tag.py\"]\n[battery.targets.single-user]\npolicy = \"single-user.toml\"\n[battery.targets.multi-user]\npolicy = \"multi-user.toml\"\nsetup = [\"Mint an app token.\"]\n";
        let target = "[policy]\nversion = 2\n[[policy.annotator]]\nname = \"acme.tag\"\nranks = [\"suspicious\", \"trusted\"]\naudiences = [\"self\"]\nmarks = []\n[[policy.tool]]\nname = \"mcp/acme/list\"\nannotator = \"acme.tag\"\n[externals.annotators.\"acme.tag\"]\ncommand = [\"python3\", \"tag.py\"]\ntoken_env = \"APPA_PROVIDER_ACME_TOKEN\"\n";
        let files = [
            (MANIFEST_FILE, manifest),
            ("appa.toml", "[policy]\nversion = 2\n"),
            ("single-user.toml", "[policy]\nversion = 2\n"),
            ("multi-user.toml", target),
            ("tag.py", "print('{}')\n"),
        ]
        .map(|(path, text)| BatteryFile {
            path: path.to_owned(),
            text: text.to_owned(),
        });
        let info = inspect(&files).unwrap();
        assert_eq!(info.namespaces, vec!["acme".to_owned()]);
        assert!(info.credentials.is_empty());
        assert!(info.externals.is_empty());
        assert_eq!(info.setup, None);
        let multi_user = info.multi_user.expect("the package declares targets");
        assert_eq!(multi_user.policy, target);
        assert_eq!(
            multi_user.credentials,
            vec!["APPA_PROVIDER_ACME_TOKEN".to_owned()]
        );
        assert_eq!(multi_user.annotators, vec!["acme.tag".to_owned()]);
        assert_eq!(multi_user.routed_annotators, vec!["acme.tag".to_owned()]);
        assert_eq!(multi_user.externals.len(), 1);
        assert_eq!(multi_user.setup.as_deref(), Some("Mint an app token."));
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
}
