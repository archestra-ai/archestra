//! The declarations a root document makes about its batteries — the `include` list,
//! the `[server_aliases]` bindings and the `[credentials]` table — read out of the
//! authored text with the line each one sits on, and written back through the
//! runtime's own comment-preserving editor.
//!
//! Reading and writing are separate: the host reads a document to show it, and edits
//! it through [`edit`], which refuses at edit time what the loader would refuse.
use appa_runtime::config::edit;
use toml_edit::Document;

/// One `include` entry, as authored.
pub(crate) struct IncludeDeclaration {
    pub entry: String,
    pub line: u32,
}

/// One `[server_aliases]` binding: a battery namespace and the catalog tool prefixes
/// it names.
pub(crate) struct AliasDeclaration {
    pub namespace: String,
    pub servers: Vec<String>,
    pub line: u32,
}

/// One `[credentials]` binding: a helper credential variable and the store key that
/// holds its value.
pub(crate) struct CredentialDeclaration {
    pub variable: String,
    pub key: String,
    pub line: u32,
}

/// What a root document declares, plus what it declares badly. A shape this reader
/// cannot make sense of is one error naming the key and its line, and the entries
/// around it are still read: the panel shows a document it cannot fully parse.
#[derive(Default)]
pub(crate) struct Declarations {
    pub include: Vec<IncludeDeclaration>,
    pub server_aliases: Vec<AliasDeclaration>,
    pub credentials: Vec<CredentialDeclaration>,
    /// The annotators the root's own tool rules route calls to.
    pub routed_annotators: Vec<String>,
    pub errors: Vec<String>,
}

pub(crate) fn parse(content: &str) -> Declarations {
    // The immutable document keeps every span pointing into `content`; the editable
    // one detaches from its input and loses them.
    let document = match Document::parse(content) {
        Ok(document) => document,
        Err(error) => {
            return Declarations {
                errors: vec![format!("root policy: {error}")],
                ..Declarations::default()
            };
        }
    };
    let mut declarations = Declarations::default();
    read_include(content, &document, &mut declarations);
    read_aliases(content, &document, &mut declarations);
    read_credentials(content, &document, &mut declarations);
    if let Ok(table) = toml::from_str::<toml::Table>(content) {
        declarations.routed_annotators = crate::policy::routed_annotators(&table);
    }
    declarations
}

fn read_include(content: &str, document: &Document<&str>, declarations: &mut Declarations) {
    let Some((key, item)) = document.get_key_value("include") else {
        return;
    };
    let at = line(content, key.span());
    let Some(entries) = item.as_array() else {
        declarations
            .errors
            .push(format!("include (line {at}): must be an array of strings"));
        return;
    };
    for entry in entries {
        let at = line(content, entry.span());
        match entry.as_str() {
            Some(entry) => declarations.include.push(IncludeDeclaration {
                entry: entry.to_owned(),
                line: at,
            }),
            None => declarations
                .errors
                .push(format!("include (line {at}): every entry must be a string")),
        }
    }
}

fn read_aliases(content: &str, document: &Document<&str>, declarations: &mut Declarations) {
    let Some((key, item)) = document.get_key_value("server_aliases") else {
        return;
    };
    let at = line(content, key.span());
    let Some(aliases) = item.as_table_like() else {
        declarations
            .errors
            .push(format!("server_aliases (line {at}): must be a table"));
        return;
    };
    for (namespace, targets) in aliases.iter() {
        let at = aliases
            .key(namespace)
            .and_then(|key| key.span())
            .map_or(at, |span| line(content, Some(span)));
        let Some(targets) = targets.as_array() else {
            declarations.errors.push(format!(
                "server_aliases.{namespace} (line {at}): must be an array of strings"
            ));
            continue;
        };
        let servers: Option<Vec<String>> = targets
            .iter()
            .map(|target| target.as_str().map(str::to_owned))
            .collect();
        match servers {
            Some(servers) => declarations.server_aliases.push(AliasDeclaration {
                namespace: namespace.to_owned(),
                servers,
                line: at,
            }),
            None => declarations.errors.push(format!(
                "server_aliases.{namespace} (line {at}): every server must be a string"
            )),
        }
    }
}

fn read_credentials(content: &str, document: &Document<&str>, declarations: &mut Declarations) {
    let Some((key, item)) = document.get_key_value("credentials") else {
        return;
    };
    let at = line(content, key.span());
    let Some(credentials) = item.as_table_like() else {
        declarations
            .errors
            .push(format!("credentials (line {at}): must be a table"));
        return;
    };
    for (variable, key) in credentials.iter() {
        let at = credentials
            .key(variable)
            .and_then(|key| key.span())
            .map_or(at, |span| line(content, Some(span)));
        match key.as_str() {
            Some(key) => declarations.credentials.push(CredentialDeclaration {
                variable: variable.to_owned(),
                key: key.to_owned(),
                line: at,
            }),
            None => declarations.errors.push(format!(
                "credentials.{variable} (line {at}): must be a string key"
            )),
        }
    }
}

/// The 1-based line a span starts on. A document this reader just parsed carries
/// every span; a missing one reads as the first line rather than as no line at all.
fn line(content: &str, span: Option<std::ops::Range<usize>>) -> u32 {
    let Some(span) = span else {
        return 1;
    };
    let before = content.get(..span.start).unwrap_or(content);
    u32::try_from(before.bytes().filter(|byte| *byte == b'\n').count() + 1).unwrap_or(u32::MAX)
}

/// One edit as the caller spells it: the kind of change and the fields that kind
/// takes. Untrusted input — [`PolicyEdit::parse`] is where it becomes an edit.
pub(crate) struct EditRequest {
    pub kind: String,
    pub entry: Option<String>,
    pub namespace: Option<String>,
    pub servers: Option<Vec<String>>,
    pub namespaces: Option<Vec<String>>,
    pub variable: Option<String>,
    pub key: Option<String>,
}

/// One change to a root document, as the runtime's editor makes it.
enum PolicyEdit {
    AddInclude {
        entry: String,
    },
    RemoveInclude {
        entry: String,
    },
    BindServers {
        namespace: String,
        servers: Vec<String>,
    },
    UnbindServers {
        namespaces: Vec<String>,
    },
    /// A key of nothing removes the variable's binding.
    SetCredential {
        variable: String,
        key: Option<String>,
    },
}

impl PolicyEdit {
    fn parse(request: EditRequest) -> Result<Self, String> {
        let EditRequest {
            kind,
            entry,
            namespace,
            servers,
            namespaces,
            variable,
            key,
        } = request;
        match kind.as_str() {
            "addInclude" => Ok(Self::AddInclude {
                entry: required(entry, &kind, "entry")?,
            }),
            "removeInclude" => Ok(Self::RemoveInclude {
                entry: required(entry, &kind, "entry")?,
            }),
            "bindServers" => Ok(Self::BindServers {
                namespace: required(namespace, &kind, "namespace")?,
                servers: required(servers, &kind, "servers")?,
            }),
            "unbindServers" => Ok(Self::UnbindServers {
                namespaces: required(namespaces, &kind, "namespaces")?,
            }),
            "setCredential" => Ok(Self::SetCredential {
                variable: required(variable, &kind, "variable")?,
                key,
            }),
            unknown => Err(format!("{unknown}: unknown edit kind")),
        }
    }

    fn apply(&self, text: &str) -> Result<String, String> {
        let edited = match self {
            Self::AddInclude { entry } => edit::add_include(text, entry),
            Self::RemoveInclude { entry } => edit::remove_include(text, entry),
            Self::BindServers { namespace, servers } => {
                edit::bind_servers(text, namespace, servers)
            }
            Self::UnbindServers { namespaces } => edit::unbind_servers(
                text,
                &namespaces.iter().map(String::as_str).collect::<Vec<_>>(),
            ),
            Self::SetCredential { variable, key } => {
                edit::set_credential(text, variable, key.as_deref())
            }
        };
        edited.map_err(|error| error.to_string())
    }
}

fn required<T>(field: Option<T>, kind: &str, name: &str) -> Result<T, String> {
    field.ok_or_else(|| format!("{kind}: {name} is required"))
}

/// Apply the edits in order to one text. The first refusal stops the sequence: a
/// caller either gets the text with every edit in it or gets no text at all.
pub(crate) fn edit(content: &str, requests: Vec<EditRequest>) -> Result<String, String> {
    let mut text = content.to_owned();
    for request in requests {
        text = PolicyEdit::parse(request)?.apply(&text)?;
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AUTHORED: &str = r#"# the organization policy
include = [
  # the bundled battery
  "batteries/github/appa.toml",
  "batteries/linear@sha256-3f9c/appa.toml",
]

# which catalogs a battery governs
[server_aliases]
github = ["github_prod", "github_sandbox"]
linear = ["linear"]

[credentials]
APPA_PROVIDER_GITHUB_TOKEN = "github_prod_token"

[policy]
version = 2
"#;

    fn request(kind: &str) -> EditRequest {
        EditRequest {
            kind: kind.to_owned(),
            entry: None,
            namespace: None,
            servers: None,
            namespaces: None,
            variable: None,
            key: None,
        }
    }

    #[test]
    fn reads_every_declaration_on_the_line_it_is_authored() {
        let declarations = parse(AUTHORED);
        assert!(declarations.errors.is_empty());
        assert_eq!(
            declarations
                .include
                .iter()
                .map(|include| (include.entry.as_str(), include.line))
                .collect::<Vec<_>>(),
            [
                ("batteries/github/appa.toml", 4),
                ("batteries/linear@sha256-3f9c/appa.toml", 5)
            ]
        );
        assert_eq!(
            declarations
                .server_aliases
                .iter()
                .map(|alias| (alias.namespace.as_str(), alias.servers.len(), alias.line))
                .collect::<Vec<_>>(),
            [("github", 2, 10), ("linear", 1, 11)]
        );
        assert_eq!(
            declarations
                .credentials
                .iter()
                .map(|credential| (
                    credential.variable.as_str(),
                    credential.key.as_str(),
                    credential.line
                ))
                .collect::<Vec<_>>(),
            [("APPA_PROVIDER_GITHUB_TOKEN", "github_prod_token", 14)]
        );
    }

    #[test]
    fn a_document_with_no_declarations_reads_as_none() {
        let declarations = parse("[policy]\nversion = 2\n");
        assert!(declarations.errors.is_empty());
        assert!(declarations.include.is_empty());
        assert!(declarations.server_aliases.is_empty());
        assert!(declarations.credentials.is_empty());
        assert!(declarations.routed_annotators.is_empty());
    }

    #[test]
    fn reads_the_annotators_the_root_rules_route_to_once_each() {
        let declarations = parse(
            "[policy]\nversion = 2\n[[policy.annotator]]\nname = \"noop\"\n[[policy.tool]]\nname = \"*\"\nannotator = \"jev.tool-call\"\n[[policy.tool]]\nname = \"mcp/github/get_me\"\nannotator = \"jev.tool-call\"\n[[policy.tool]]\nname = \"mcp/github/list\"\nannotator = \"noop\"\n[[policy.tool]]\nname = \"mcp/github/search\"\ndelta = {}\n",
        );
        assert!(declarations.errors.is_empty());
        assert_eq!(declarations.routed_annotators, ["jev.tool-call", "noop"]);
    }

    #[test]
    fn every_malformed_shape_is_an_error_naming_the_key() {
        for (content, key) in [
            ("include = \"batteries/github/appa.toml\"\n", "include"),
            ("include = [3]\n", "include"),
            ("server_aliases = 3\n", "server_aliases"),
            (
                "[server_aliases]\ngithub = \"github_prod\"\n",
                "server_aliases.github",
            ),
            ("[server_aliases]\ngithub = [3]\n", "server_aliases.github"),
            ("credentials = 3\n", "credentials"),
            (
                "[credentials]\nAPPA_PROVIDER_GITHUB_TOKEN = 3\n",
                "credentials.APPA_PROVIDER_GITHUB_TOKEN",
            ),
        ] {
            let declarations = parse(content);
            assert_eq!(declarations.errors.len(), 1, "{content}");
            assert!(
                declarations.errors[0].contains(key),
                "{content}: {:?}",
                declarations.errors
            );
        }
        // An unparsable document is one error and no declarations.
        let broken = parse("include = [\n");
        assert_eq!(broken.errors.len(), 1);
        assert!(broken.include.is_empty());
    }

    #[test]
    fn a_sequence_of_edits_keeps_the_authored_text_around_the_lines_it_changes() {
        let edited = edit(
            AUTHORED,
            vec![
                EditRequest {
                    entry: Some("batteries/slack/appa.toml".into()),
                    ..request("addInclude")
                },
                EditRequest {
                    namespace: Some("slack".into()),
                    servers: Some(vec!["slack_prod".into()]),
                    ..request("bindServers")
                },
                EditRequest {
                    entry: Some("batteries/linear@sha256-3f9c/appa.toml".into()),
                    ..request("removeInclude")
                },
                EditRequest {
                    namespaces: Some(vec!["linear".into()]),
                    ..request("unbindServers")
                },
                EditRequest {
                    variable: Some("APPA_PROVIDER_GITHUB_TOKEN".into()),
                    key: None,
                    ..request("setCredential")
                },
            ],
        )
        .unwrap();
        let declarations = parse(&edited);
        assert!(declarations.errors.is_empty());
        assert_eq!(
            declarations
                .include
                .iter()
                .map(|include| include.entry.as_str())
                .collect::<Vec<_>>(),
            ["batteries/github/appa.toml", "batteries/slack/appa.toml"]
        );
        assert_eq!(
            declarations
                .server_aliases
                .iter()
                .map(|alias| (alias.namespace.as_str(), alias.servers.clone()))
                .collect::<Vec<_>>(),
            [
                (
                    "github",
                    vec!["github_prod".into(), "github_sandbox".into()]
                ),
                ("slack", vec!["slack_prod".to_owned()])
            ]
        );
        assert!(declarations.credentials.is_empty());
        for authored in [
            "# the organization policy",
            "# the bundled battery\n  \"batteries/github/appa.toml\",",
            "# which catalogs a battery governs",
            "github = [\"github_prod\", \"github_sandbox\"]",
            "[policy]\nversion = 2\n",
        ] {
            assert!(edited.contains(authored), "{authored} survives:\n{edited}");
        }
    }

    #[test]
    fn an_edit_the_document_already_satisfies_changes_nothing() {
        let unchanged = edit(
            AUTHORED,
            vec![
                EditRequest {
                    entry: Some("batteries/github/appa.toml".into()),
                    ..request("addInclude")
                },
                EditRequest {
                    namespace: Some("linear".into()),
                    servers: Some(vec!["linear".into()]),
                    ..request("bindServers")
                },
                EditRequest {
                    variable: Some("APPA_PROVIDER_GITHUB_TOKEN".into()),
                    key: Some("github_prod_token".into()),
                    ..request("setCredential")
                },
                EditRequest {
                    entry: Some("batteries/slack/appa.toml".into()),
                    ..request("removeInclude")
                },
            ],
        )
        .unwrap();
        assert_eq!(unchanged, AUTHORED);
    }

    #[test]
    fn a_refused_edit_stops_the_sequence_and_returns_no_text() {
        let missing = edit(AUTHORED, vec![request("addInclude")]).unwrap_err();
        assert!(
            missing.contains("addInclude") && missing.contains("entry"),
            "{missing}"
        );
        let unknown = edit(AUTHORED, vec![request("rewriteEverything")]).unwrap_err();
        assert!(unknown.contains("rewriteEverything"), "{unknown}");
        // The loader's own refusals reach the editor: an entry outside the root and a
        // credential variable no helper may read.
        let traversing = edit(
            AUTHORED,
            vec![EditRequest {
                entry: Some("../secrets/appa.toml".into()),
                ..request("addInclude")
            }],
        )
        .unwrap_err();
        assert!(traversing.contains("../secrets/appa.toml"), "{traversing}");
        let foreign = edit(
            AUTHORED,
            vec![EditRequest {
                variable: Some("PATH".into()),
                key: Some("github_prod_token".into()),
                ..request("setCredential")
            }],
        )
        .unwrap_err();
        assert!(foreign.contains("PATH"), "{foreign}");
    }
}
