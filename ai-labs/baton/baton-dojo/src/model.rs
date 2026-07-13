//! Constructing the OpenRouter model the agent drives (rig-core).

use rig_core::client::{CompletionClient, ProviderClient};
use rig_core::providers::openrouter;

use crate::error::DojoError;

/// The concrete model the [`Agent`](crate::Agent) drives: OpenRouter via rig-core.
pub type Model = openrouter::CompletionModel;

/// Build a model, reading the key from the `OPENROUTER_API_KEY` process environment variable.
pub fn from_env(model: impl Into<String>) -> Result<Model, DojoError> {
    let client = openrouter::Client::from_env().map_err(|e| DojoError::Client(e.to_string()))?;
    Ok(client.completion_model(model))
}

/// Build a model from an explicit API key.
pub fn with_key(model: impl Into<String>, api_key: &str) -> Result<Model, DojoError> {
    let client = openrouter::Client::new(api_key).map_err(|e| DojoError::Client(e.to_string()))?;
    Ok(client.completion_model(model))
}
