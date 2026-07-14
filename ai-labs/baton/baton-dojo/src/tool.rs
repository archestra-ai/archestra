//! Tools declared over a workspace `W`.
//!
//! A [`Tool`] is a named, JSON-schema-described callable that reads and mutates
//! `W`. A [`Toolset`] groups the tools for one workspace and is what the agent
//! is handed. Tools are the AgentDojo "tools runtime": the only way the model
//! changes the environment.

use rig_core::completion::ToolDefinition;

/// Why a tool call did not produce a value.
#[derive(Debug, thiserror::Error)]
pub enum ToolError {
    /// The model named a tool that is not in the toolset.
    #[error("unknown tool: {0}")]
    UnknownTool(String),
    /// The arguments the model supplied could not be used (malformed JSON,
    /// missing/typed-wrong fields).
    #[error("bad arguments for `{tool}`: {detail}")]
    BadArgs { tool: String, detail: String },
    /// The tool ran but failed.
    #[error("tool `{tool}` failed: {detail}")]
    Failed { tool: String, detail: String },
}

/// One declared tool over workspace `W`: a schema the model sees plus a handler
/// that reads/mutates `W`.
pub struct Tool<W> {
    name: String,
    description: String,
    parameters: serde_json::Value,
    #[allow(clippy::type_complexity)]
    handler: Box<dyn Fn(&mut W, serde_json::Value) -> Result<serde_json::Value, ToolError> + Send + Sync>,
}

/// The set of tools bound to a workspace `W`. Build with [`Toolset::new`] and
/// [`Toolset::tool`], then [`Toolset::finalize`] to reject duplicate names.
pub struct Toolset<W> {
    tools: Vec<Tool<W>>,
}

impl<W> Toolset<W> {
    /// An empty toolset.
    pub fn new() -> Self {
        Self { tools: Vec::new() }
    }

    /// Declare a tool. `parameters` is a JSON Schema for the arguments object.
    /// The handler receives the workspace and the parsed arguments and returns a
    /// JSON result (which the model sees) or a [`ToolError`].
    pub fn tool(
        mut self,
        name: impl Into<String>,
        description: impl Into<String>,
        parameters: serde_json::Value,
        handler: impl Fn(&mut W, serde_json::Value) -> Result<serde_json::Value, ToolError> + Send + Sync + 'static,
    ) -> Self {
        self.tools.push(Tool {
            name: name.into(),
            description: description.into(),
            parameters,
            handler: Box::new(handler),
        });
        self
    }

    /// Validate the toolset. Rejects duplicate tool names — the policy boundary
    /// and the model's tool namespace both require unique names.
    pub fn finalize(self) -> Result<Self, crate::error::DojoError> {
        let mut seen = std::collections::HashSet::new();
        for tool in &self.tools {
            if !seen.insert(tool.name.as_str()) {
                return Err(crate::error::DojoError::DuplicateTool(tool.name.clone()));
            }
        }
        Ok(self)
    }

    /// The tool definitions exposed to the model, in declaration order.
    pub fn schemas(&self) -> Vec<ToolDefinition> {
        self.tools
            .iter()
            .map(|t| ToolDefinition {
                name: t.name.clone(),
                description: t.description.clone(),
                parameters: t.parameters.clone(),
            })
            .collect()
    }

    /// Whether a tool with this name is declared.
    pub fn contains(&self, name: &str) -> bool {
        self.tools.iter().any(|t| t.name == name)
    }

    /// Run a tool by name against the workspace.
    pub fn dispatch(&self, ws: &mut W, name: &str, args: serde_json::Value) -> Result<serde_json::Value, ToolError> {
        match self.tools.iter().find(|t| t.name == name) {
            Some(tool) => (tool.handler)(ws, args),
            None => Err(ToolError::UnknownTool(name.to_owned())),
        }
    }
}

impl<W> Default for Toolset<W> {
    fn default() -> Self {
        Self::new()
    }
}
