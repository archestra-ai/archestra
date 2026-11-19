//! JSON-RPC messages: what kind a message is, id rewriting, and the messages
//! that the tunnel client makes itself.

use serde::Serialize;
use serde_json::{Value, json};

/// The MCP protocol version that the client asks for in its own `initialize`.
pub(crate) const PROTOCOL_VERSION: &str = "2025-06-18";

pub(crate) const INITIALIZE: &str = "initialize";
pub(crate) const INITIALIZED: &str = "notifications/initialized";
const CANCELLED: &str = "notifications/cancelled";

const METHOD_NOT_FOUND: i64 = -32601;
pub(crate) const INVALID_PARAMS: i64 = -32602;
pub(crate) const INTERNAL_ERROR: i64 = -32603;

#[derive(Debug, PartialEq)]
pub(crate) enum MessageKind {
    /// Has `id` and `method`.
    Request { id: Value, method: String },
    /// Has `method` and no `id`.
    Notification { method: String },
    /// Has `id` and no `method`.
    Response { id: Value },
    /// Not a JSON-RPC message.
    Invalid,
}

pub(crate) fn classify(message: &Value) -> MessageKind {
    let Some(object) = message.as_object() else {
        return MessageKind::Invalid;
    };
    let id = object.get("id").filter(|id| !id.is_null()).cloned();
    let method = object.get("method").and_then(Value::as_str);
    match (id, method) {
        (Some(id), Some(method)) => MessageKind::Request {
            id,
            method: method.to_owned(),
        },
        (None, Some(method)) => MessageKind::Notification {
            method: method.to_owned(),
        },
        (Some(id), None) => MessageKind::Response { id },
        (None, None) => MessageKind::Invalid,
    }
}

/// `true` when a polled notification goes to the MCP server. Two do not:
/// - `notifications/initialized`: the client sent it itself, after its own
///   `initialize`.
/// - `notifications/cancelled`: it names a request by the id of the caller.
///   The MCP server knows that request by another id (see [`set_id`]), and
///   the id of the caller can be the id of a request of another caller there.
pub(crate) fn is_forwarded_notification(method: &str) -> bool {
    !matches!(method, INITIALIZED | CANCELLED)
}

/// Writes `id` into a message. A forwarded request gets a new id for the MCP
/// server with this, and its answer gets the id of the caller back.
pub(crate) fn set_id(message: &mut Value, id: Value) {
    if let Some(object) = message.as_object_mut() {
        object.insert("id".to_owned(), id);
    }
}

/// The `initialize` request that the client sends to each MCP server.
pub(crate) fn initialize_request(id: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": INITIALIZE,
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {
                "name": "archestra-mcp-bridge",
                "version": env!("CARGO_PKG_VERSION"),
            },
        },
    })
}

pub(crate) fn initialized_notification() -> Value {
    json!({ "jsonrpc": "2.0", "method": INITIALIZED })
}

/// A notification with `params`.
pub(crate) fn notification(method: &str, params: &impl Serialize) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

pub(crate) fn result_response(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

pub(crate) fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

/// The answer to a request with a method that the client does not have: a
/// request of an MCP server to the client (sampling, roots), or a request of
/// Archestra to the tunnel client itself.
pub(crate) fn method_not_found(id: Value, method: &str) -> Value {
    error_response(id, METHOD_NOT_FOUND, &format!("Method not found: {method}"))
}

/// `error.data.tunnel_failure` of the OpenAI tunnel protocol, version 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TunnelFailure {
    pub source: &'static str,
    pub upstream_response_received: bool,
    /// Only for `source: "target_http"`.
    pub upstream_status: Option<u16>,
}

/// The error that the client makes when no MCP answer exists. `message` is
/// what the person who uses the agent reads, so it says what went wrong.
pub(crate) fn tunnel_failure_response(id: Value, message: &str, failure: TunnelFailure) -> Value {
    let mut tunnel_failure = json!({
        "version": 1,
        "source": failure.source,
        "upstream_response_received": failure.upstream_response_received,
    });
    if let Some(status) = failure.upstream_status {
        tunnel_failure["upstream_status"] = json!(status);
    }
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": INTERNAL_ERROR,
            "message": message,
            "data": { "tunnel_failure": tunnel_failure },
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_messages() {
        assert_eq!(
            classify(&json!({"jsonrpc": "2.0", "id": 7, "method": "tools/list"})),
            MessageKind::Request {
                id: json!(7),
                method: "tools/list".to_owned()
            }
        );
        assert_eq!(
            classify(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"})),
            MessageKind::Notification {
                method: "notifications/initialized".to_owned()
            }
        );
        assert_eq!(
            classify(&json!({"jsonrpc": "2.0", "id": "a", "result": {}})),
            MessageKind::Response { id: json!("a") }
        );
        assert_eq!(
            classify(&json!({"jsonrpc": "2.0", "id": null, "method": "x"})),
            MessageKind::Notification {
                method: "x".to_owned()
            }
        );
        assert_eq!(classify(&json!({"jsonrpc": "2.0"})), MessageKind::Invalid);
        assert_eq!(classify(&json!([1, 2])), MessageKind::Invalid);
    }

    #[test]
    fn initialized_and_cancelled_are_not_forwarded() {
        assert!(!is_forwarded_notification("notifications/initialized"));
        assert!(!is_forwarded_notification("notifications/cancelled"));
        assert!(is_forwarded_notification(
            "notifications/roots/list_changed"
        ));
        assert!(is_forwarded_notification("notifications/progress"));
    }

    #[test]
    fn rewrites_the_id_and_puts_the_original_back() {
        let mut request = json!({"jsonrpc": "2.0", "id": "caller-1", "method": "tools/list"});
        let MessageKind::Request { id: original, .. } = classify(&request) else {
            panic!("not a request");
        };

        set_id(&mut request, json!(42));
        assert_eq!(
            request,
            json!({"jsonrpc": "2.0", "id": 42, "method": "tools/list"})
        );

        let mut answer = json!({"jsonrpc": "2.0", "id": 42, "result": {"tools": []}});
        set_id(&mut answer, original);
        assert_eq!(
            answer,
            json!({"jsonrpc": "2.0", "id": "caller-1", "result": {"tools": []}})
        );
    }

    #[test]
    fn method_not_found_shape() {
        assert_eq!(
            method_not_found(json!("srv-1"), "roots/list"),
            json!({
                "jsonrpc": "2.0",
                "id": "srv-1",
                "error": {"code": -32601, "message": "Method not found: roots/list"},
            })
        );
    }

    #[test]
    fn tunnel_failure_shape() {
        let closed = TunnelFailure {
            source: "transport_closed",
            upstream_response_received: false,
            upstream_status: None,
        };
        assert_eq!(
            tunnel_failure_response(json!(1), "Bad Gateway", closed),
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "error": {
                    "code": -32603,
                    "message": "Bad Gateway",
                    "data": {"tunnel_failure": {
                        "version": 1,
                        "source": "transport_closed",
                        "upstream_response_received": false,
                    }},
                },
            })
        );

        let target = TunnelFailure {
            source: "target_http",
            upstream_response_received: true,
            upstream_status: Some(503),
        };
        assert_eq!(
            tunnel_failure_response(json!("x"), "Bad Gateway", target)["error"]["data"]["tunnel_failure"],
            json!({
                "version": 1,
                "source": "target_http",
                "upstream_response_received": true,
                "upstream_status": 503,
            })
        );
    }

    #[test]
    fn initialize_request_shape() {
        let request = initialize_request(1);
        assert_eq!(request["id"], json!(1));
        assert_eq!(request["method"], json!("initialize"));
        assert_eq!(
            request["params"]["protocolVersion"],
            json!(PROTOCOL_VERSION)
        );
        assert_eq!(
            request["params"]["clientInfo"]["name"],
            json!("archestra-mcp-bridge")
        );
    }
}
