//! The dummy tool catalog: the single source of truth shared by the MCP server (which exposes these
//! tools) and the agent (which wraps each in an AFC-governed proxy). Each tool carries both its
//! model/MCP-facing `tool_name` (underscored — the grammar OpenAI-compatible function names accept)
//! and its `afc_id` (dotted — the id the AFC policy in `afc-demo/config/annotations.yaml` governs by).
//! The two names form an explicit bijection; nothing else in the crate hardcodes the mapping.

use serde_json::{Map, Value, json};

/// One dummy tool: its two names, description, and JSON-Schema argument shape.
pub struct ToolDef {
    /// The dotted AFC policy id (`drive.read_doc`) — how the engine governs the call.
    pub afc_id: &'static str,
    /// The model/MCP-facing function name (`drive_read_doc`).
    pub tool_name: &'static str,
    pub description: &'static str,
    /// JSON Schema (an object) for the tool's arguments.
    pub schema: Value,
}

/// The five governed tools, mirroring the vocabulary annotated in `afc-demo/config/annotations.yaml`.
pub fn catalog() -> Vec<ToolDef> {
    vec![
        ToolDef {
            afc_id: "drive.read_doc",
            tool_name: "drive_read_doc",
            description: "Read a company document by id and return its contents.",
            schema: json!({
                "type": "object",
                "properties": { "doc": { "type": "string", "description": "Document id, e.g. \"A\"." } },
                "required": ["doc"],
            }),
        },
        ToolDef {
            afc_id: "drive.write_doc",
            tool_name: "drive_write_doc",
            description: "Write content into a company document by id.",
            schema: json!({
                "type": "object",
                "properties": {
                    "doc": { "type": "string", "description": "Target document id." },
                    "content": { "type": "string", "description": "Content to write." },
                },
                "required": ["doc", "content"],
            }),
        },
        ToolDef {
            afc_id: "web.fetch",
            tool_name: "web_fetch",
            description: "Fetch the text of a public web page by URL.",
            schema: json!({
                "type": "object",
                "properties": { "url": { "type": "string", "description": "The URL to fetch." } },
                "required": ["url"],
            }),
        },
        ToolDef {
            afc_id: "email.send",
            tool_name: "email_send",
            description: "Send an email to a recipient with a body.",
            schema: json!({
                "type": "object",
                "properties": {
                    "to": { "type": "string", "description": "Recipient address or id." },
                    "body": { "type": "string", "description": "Email body." },
                },
                "required": ["to", "body"],
            }),
        },
        ToolDef {
            afc_id: "crm.export",
            tool_name: "crm_export",
            description: "Export a CRM record to a region.",
            schema: json!({
                "type": "object",
                "properties": {
                    "region": { "type": "string", "description": "Destination region, e.g. \"US\" or \"EU\"." },
                    "record": { "type": "string", "description": "Record id to export." },
                },
                "required": ["region", "record"],
            }),
        },
    ]
}

/// Map a model/MCP tool name to its AFC policy id.
pub fn afc_id_for(tool_name: &str) -> Option<&'static str> {
    catalog()
        .into_iter()
        .find(|t| t.tool_name == tool_name)
        .map(|t| t.afc_id)
}

/// Map an AFC policy id back to its model/MCP tool name.
pub fn tool_name_for(afc_id: &str) -> Option<&'static str> {
    catalog()
        .into_iter()
        .find(|t| t.afc_id == afc_id)
        .map(|t| t.tool_name)
}

fn arg<'a>(args: &'a Map<String, Value>, key: &str) -> &'a str {
    args.get(key).and_then(Value::as_str).unwrap_or("")
}

/// The dummy content a tool returns. This is what the MCP server serves; the agent labels read
/// results and folds them into the session context, then governs later egress against that context.
/// `web.fetch` on a `news.example` URL returns the standard injection fixture, so the live model
/// meets the same adversarial content the scripted scenario uses.
pub fn respond(tool_name: &str, args: &Map<String, Value>) -> String {
    match tool_name {
        "drive_read_doc" => match arg(args, "doc") {
            "A" => {
                "Contents of confidential doc A: Q3 revenue was $4.2M, up 18% YoY; not yet public."
                    .to_string()
            }
            "B" => "Contents of doc B (team-wide): this week's standup notes.".to_string(),
            other => format!("Contents of doc {other}."),
        },
        "drive_write_doc" => format!(
            "Wrote {} characters to doc {}.",
            arg(args, "content").len(),
            arg(args, "doc"),
        ),
        "web_fetch" => {
            let url = arg(args, "url");
            if url.contains("news.example") {
                format!(
                    "Fetched {url}. Page text:\nTop headline: markets steady.\n\n{}",
                    afc_demo::fixtures::INJECTION
                )
            } else {
                format!("Fetched {url}. Page text: (generic public web content).")
            }
        }
        "email_send" => format!("Email sent to {}.", arg(args, "to")),
        "crm_export" => format!(
            "Exported record {} to region {}.",
            arg(args, "record"),
            arg(args, "region")
        ),
        other => format!("Unknown tool {other:?}."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_five_tools_with_object_schemas() {
        let cat = catalog();
        assert_eq!(cat.len(), 5);
        for t in &cat {
            assert_eq!(t.schema.get("type").and_then(Value::as_str), Some("object"));
            assert!(
                t.schema.get("properties").is_some(),
                "{} lacks properties",
                t.tool_name
            );
        }
    }

    #[test]
    fn name_bijection_round_trips_both_ways() {
        for t in catalog() {
            assert_eq!(afc_id_for(t.tool_name), Some(t.afc_id));
            assert_eq!(tool_name_for(t.afc_id), Some(t.tool_name));
        }
        assert_eq!(afc_id_for("nope"), None);
        assert_eq!(tool_name_for("nope.nope"), None);
    }

    #[test]
    fn web_fetch_of_news_serves_the_injection_fixture() {
        // Behavioral contract: the tainted-source demo depends on news URLs carrying the injection
        // payload. Referencing the shared constant (not a literal) keeps this robust to rewording.
        let mut args = Map::new();
        args.insert(
            "url".to_string(),
            Value::String("http://news.example/today".to_string()),
        );
        let out = respond("web_fetch", &args);
        assert!(
            out.contains(afc_demo::fixtures::INJECTION),
            "news fetch must carry the injection"
        );
    }
}
