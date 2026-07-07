//! Adapts the AFC gate to nitpicker's `Tool` trait. Each model-visible tool is a `GovernedTool`
//! whose `call()` is the interception point: it forwards the call to the governance actor (see
//! [`crate::actor`]) and returns the actor's verdict text. The actor serializes every call through
//! the engine, so a read's taint is committed before any later call is checked.

use std::collections::HashMap;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;

use eyre::Result;
use nitpicker_agent::tools::Tool;
use rig_core::completion::ToolDefinition;
use serde_json::Value;

use crate::actor::GovernanceHandle;
use crate::catalog;

pub struct GovernedTool {
    tool_name: String,
    description: String,
    schema: Value,
    handle: GovernanceHandle,
}

impl Tool for GovernedTool {
    fn name(&self) -> String {
        self.tool_name.clone()
    }

    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.tool_name.clone(),
            description: self.description.clone(),
            parameters: self.schema.clone(),
        }
    }

    fn call(
        &self,
        args: Value,
        _work_dir: PathBuf,
    ) -> Pin<Box<dyn std::future::Future<Output = Result<String>> + Send>> {
        let handle = self.handle.clone();
        let tool_name = self.tool_name.clone();
        Box::pin(async move {
            let args_map = args.as_object().cloned().unwrap_or_default();
            handle.govern(tool_name, args_map).await
        })
    }
}

/// Build the governed tool map (model name → tool) from the catalog, all sharing one governance
/// actor handle so the session context and engine stay consistent across calls.
pub fn governed_tools(handle: GovernanceHandle) -> HashMap<String, Arc<dyn Tool>> {
    catalog::catalog()
        .into_iter()
        .map(|t| {
            let tool: Arc<dyn Tool> = Arc::new(GovernedTool {
                tool_name: t.tool_name.to_string(),
                description: t.description.to_string(),
                schema: t.schema,
                handle: handle.clone(),
            });
            (t.tool_name.to_string(), tool)
        })
        .collect()
}
