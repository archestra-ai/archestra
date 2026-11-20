use axum::Json;
use serde::{Deserialize, Serialize};

const STATELESS: &str = "2026-07-28";
const LEGACY: &str = "2025-11-25";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    header_version: Option<String>,
    meta_version: Option<String>,
    header_method: Option<String>,
    header_name: Option<String>,
    method: Option<String>,
    name: Option<String>,
    uri: Option<String>,
    task_id: Option<String>,
    sdk_versions: Vec<String>,
    has_client_meta: bool,
    has_id: bool,
    is_request: bool,
    skills_enabled: bool,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Dispatch {
    Unsupported {
        code: i32,
        message: String,
        data: Versions,
    },
    Mismatch {
        revision: &'static str,
        code: i32,
        message: String,
    },
    Route {
        resolution: Resolution,
        target: Target,
    },
}

#[derive(Serialize)]
pub(crate) struct Versions {
    supported: Vec<String>,
    requested: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Resolution {
    revision: &'static str,
    declared_explicitly: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    declared_version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Target {
    Removed,
    Task,
    Skill,
    Subscription,
    Discover,
    Sdk,
}

pub(crate) async fn dispatch(Json(request): Json<Request>) -> Json<Dispatch> {
    Json(route(request))
}

fn route(request: Request) -> Dispatch {
    let declared = request
        .header_version
        .as_ref()
        .or(request.meta_version.as_ref())
        .filter(|value| !value.is_empty());
    let revision = match declared {
        Some(version) if version == STATELESS => STATELESS,
        Some(version) if request.sdk_versions.contains(version) => LEGACY,
        Some(version) => {
            let supported: Vec<_> = [STATELESS.to_owned(), LEGACY.to_owned()]
                .into_iter()
                .chain(
                    request
                        .sdk_versions
                        .into_iter()
                        .filter(|version| version != LEGACY),
                )
                .collect();
            return Dispatch::Unsupported {
                code: -32022,
                message: format!(
                    "Unsupported MCP protocol version \"{version}\". Supported versions: {}.",
                    supported.join(", ")
                ),
                data: Versions {
                    supported,
                    requested: version.clone(),
                },
            };
        }
        None if request.header_method.is_some() || request.has_client_meta => STATELESS,
        None => LEGACY,
    };
    let stateless = revision == STATELESS;
    let method = request.method.as_deref().unwrap_or_default();
    let name = match method {
        "tools/call" | "prompts/get" => request.name.as_deref(),
        "resources/read" => request.uri.as_deref(),
        "tasks/get" | "tasks/update" | "tasks/cancel" => request.task_id.as_deref(),
        _ => None,
    };
    let required = stateless && declared.is_some() && request.is_request;
    if !method.is_empty() {
        let error = match (
            request.header_method.as_deref(),
            request.header_name.as_deref(),
            name,
        ) {
            (Some(header), _, _) if header != method => Some(format!(
                "Routing header mismatch: mcp-method \"{header}\" does not match request method \"{method}\"."
            )),
            (_, Some(header), Some(name)) if header != name => Some(format!(
                "Routing header mismatch: mcp-name \"{header}\" does not match request target \"{name}\"."
            )),
            (_, Some(_), None) => Some(format!(
                "Routing header mismatch: mcp-name was sent for method \"{method}\", which addresses no named target."
            )),
            (None, _, _) if required => Some(format!(
                "Missing required mcp-method header for protocol version {STATELESS}."
            )),
            (_, None, Some(_)) if required => Some(format!(
                "Missing required mcp-name header for method \"{method}\" under protocol version {STATELESS}."
            )),
            _ => None,
        };
        if let Some(message) = error {
            return Dispatch::Mismatch {
                revision,
                code: -32020,
                message,
            };
        }
    }
    let target = match method {
        "ping" | "logging/setLevel" | "resources/subscribe" | "resources/unsubscribe"
            if stateless =>
        {
            Target::Removed
        }
        "tasks/get" | "tasks/update" | "tasks/cancel" if stateless => Target::Task,
        "skills/list" | "skills/get" | "resources/directory/read"
            if request.skills_enabled && request.has_id =>
        {
            Target::Skill
        }
        "subscriptions/listen" if stateless => Target::Subscription,
        "server/discover" => Target::Discover,
        _ => Target::Sdk,
    };
    Dispatch::Route {
        resolution: Resolution {
            revision,
            declared_explicitly: declared.is_some(),
            declared_version: declared.cloned(),
        },
        target,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> Request {
        Request {
            header_version: Some(STATELESS.into()),
            meta_version: Some(LEGACY.into()),
            header_method: Some("tools/call".into()),
            header_name: Some("different".into()),
            method: Some("tools/call".into()),
            name: Some("note".into()),
            uri: None,
            task_id: None,
            sdk_versions: vec![LEGACY.into()],
            has_client_meta: false,
            has_id: true,
            is_request: true,
            skills_enabled: true,
        }
    }

    #[test]
    fn names_must_match_even_for_legacy_clients() {
        for version in [STATELESS, LEGACY] {
            let mut input = request();
            input.header_version = Some(version.into());
            assert!(matches!(
                route(input),
                Dispatch::Mismatch { code: -32020, .. }
            ));
        }
    }

    #[test]
    fn explicit_revision_precedes_meta_but_notifications_need_no_routing_headers() {
        let mut input = request();
        input.header_method = None;
        input.header_name = None;
        input.has_id = false;
        input.is_request = false;
        input.method = Some("skills/list".into());
        assert!(matches!(
            route(input),
            Dispatch::Route {
                resolution: Resolution {
                    revision: STATELESS,
                    declared_explicitly: true,
                    ..
                },
                target: Target::Sdk,
            }
        ));
    }
}
