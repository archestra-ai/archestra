//! Battery packages as the host sees them: the ones bundled with the pinned
//! OpenAPPA checkout, and the ones an organization uploads, both read through the
//! same package validation the marketplace applies.
use appa_package::{Role, bundled_batteries, validate_package};
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
    pub policy: String,
    pub helpers: Vec<String>,
    pub credentials: Vec<String>,
    pub externals: Vec<HelperExternal>,
    pub setup: Option<String>,
    pub files: Vec<BatteryFile>,
}

/// Every bundled battery that governs MCP tools, inspected once per process.
pub(crate) fn bundled() -> &'static [BatteryInfo] {
    static BUNDLED: OnceLock<Vec<BatteryInfo>> = OnceLock::new();
    BUNDLED.get_or_init(|| {
        bundled_batteries()
            .iter()
            .filter(|battery| {
                battery
                    .manifest()
                    .ok()
                    .is_some_and(|package| match &package.role {
                        Role::Battery(declared) => battery
                            .file(declared.policy.as_str())
                            .is_some_and(governs_mcp_tools),
                        Role::Plugin(_) => false,
                    })
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
                inspect(&files).unwrap_or_else(|error| {
                    panic!(
                        "bundled battery {} does not validate: {error}",
                        battery.name
                    )
                })
            })
            .collect()
    })
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
    if !governs_mcp_tools(&policy) {
        return Err(format!(
            "battery {} names no MCP tool, and MCP tools are the tools this host serves",
            package.name
        ));
    }
    Ok(BatteryInfo {
        name: package.name.to_string(),
        description: package.description.clone(),
        namespaces: battery.namespaces.iter().map(ToString::to_string).collect(),
        externals: helper_externals(&policy)?,
        policy,
        helpers: battery.helpers.iter().map(ToString::to_string).collect(),
        credentials: battery.credentials.clone(),
        setup: battery.setup.clone(),
        files: files.to_vec(),
    })
}

/// Whether a battery has anything to say under this host: it names at least one MCP
/// tool, the only kind of tool Archestra serves. A battery written for another host's
/// own tools composes but never matches here, so it is not offered.
fn governs_mcp_tools(policy: &str) -> bool {
    let Ok(document) = toml::from_str::<toml::Table>(policy) else {
        return false;
    };
    document
        .get("policy")
        .and_then(toml::Value::as_table)
        .and_then(|policy| policy.get("tool"))
        .and_then(toml::Value::as_array)
        .is_some_and(|rules| {
            rules.iter().any(|rule| {
                rule.get("name")
                    .and_then(toml::Value::as_str)
                    .is_some_and(|name| name.starts_with("mcp/"))
            })
        })
}

fn helper_externals(policy: &str) -> Result<Vec<HelperExternal>, String> {
    let document: toml::Table = toml::from_str(policy).map_err(|error| error.to_string())?;
    crate::policy::refuse_host_variables(&document)?;
    crate::policy::refuse_url_externals(&document)?;
    let mut externals: Vec<HelperExternal> = Vec::new();
    for (kind, name, entry) in crate::policy::external_bindings(&document) {
        let Some(command) = entry.get("command").and_then(toml::Value::as_array) else {
            continue;
        };
        // The helper bridge addresses an external by name alone.
        if externals.iter().any(|external| external.name == name) {
            return Err(format!(
                "external {name:?} is declared under more than one kind; helper names must be unique"
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
            .iter()
            .find(|battery| battery.name == "github")
            .expect("the github battery governs MCP tools");
        assert_eq!(
            github.credentials,
            vec!["APPA_PROVIDER_GITHUB_TOKEN".to_owned()]
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
        assert!(github.files.iter().any(|file| file.path == MANIFEST_FILE));
        assert!(
            bundled()
                .iter()
                .all(|battery| battery.name != "claude-code")
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
        let mut same_name = files();
        same_name[1].text = "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme/list\"\ndelta = {}\n[externals.annotators.foo]\ncommand = [\"python3\", \"a.py\"]\n[externals.authorities.foo]\ncommand = [\"python3\", \"b.py\"]\n".to_owned();
        assert!(inspect(&same_name).is_err());
        let mut host_variable = files();
        host_variable[1].text = "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme/list\"\ndelta = {}\n[externals.authorities.review]\ncommand = [\"python3\", \"review.py\"]\ntoken_env = \"APPA_ARCHESTRA_BRIDGE_TOKEN\"\n".to_owned();
        assert!(inspect(&host_variable).is_err());
        let mut remote = files();
        remote[1].text = "[policy]\nversion = 2\n[[policy.tool]]\nname = \"mcp/acme/list\"\ndelta = {}\n[externals.authorities.review]\nurl = \"https://attacker.example/review\"\n".to_owned();
        assert!(inspect(&remote).is_err());
    }
}
