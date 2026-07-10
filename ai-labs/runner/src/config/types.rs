use std::path::PathBuf;
use std::str::FromStr;

use serde::Serialize;

/// How the platform exposes an agent's assigned tools to the model. Mirrors the backend's closed
/// `ToolExposureModeSchema` (platform/backend/src/types/agent.ts:44) -- keep the variants in sync; an
/// unknown value in an env's `[platform]` block is a loud config error, never a passed-through string.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ToolExposureMode {
    /// The model gets the entire assigned tool list up front; no meta-tools.
    Full,
    /// The model sees only the `search_tools`/`run_tool` meta-tools and discovers its tools at runtime.
    #[default]
    SearchAndRunOnly,
}

impl ToolExposureMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ToolExposureMode::Full => "full",
            ToolExposureMode::SearchAndRunOnly => "search_and_run_only",
        }
    }
}

impl std::fmt::Display for ToolExposureMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for ToolExposureMode {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "full" => Ok(ToolExposureMode::Full),
            "search_and_run_only" => Ok(ToolExposureMode::SearchAndRunOnly),
            other => Err(format!(
                "unknown tool_exposure_mode {other:?}; expected one of [full, search_and_run_only]"
            )),
        }
    }
}

/// Platform feature flags applied when creating an env's agents. One typed field per backend flag the
/// benchmark can toggle; defaults preserve current behavior. Add a flag here + in `AgentCreate`.
#[derive(Debug, Clone, Default, Serialize)]
pub struct PlatformConfig {
    pub tool_exposure_mode: ToolExposureMode,
}

#[derive(Debug, Clone)]
pub struct SkillRef {
    pub repo: String,
    pub path: Option<String>,
    pub ref_: String,
    pub cap: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct Mcp {
    pub name: String,
    pub server_url: String,
}

#[derive(Debug, Clone)]
pub struct EnvConfig {
    pub id: String,
    pub name: String,
    pub agent_name: String,
    pub agent_system_prompt: String,
    pub skills: Vec<SkillRef>,
    pub mcps: Vec<Mcp>,
    pub tasks: Vec<Task>,
    pub tools: Vec<String>,
    pub share_backend: bool,
    /// When set, the harness starts its synthetic `acme_it` MCP and registers it to this env's agents.
    /// Works in both modes: shared backends start one instance for all lanes, isolated lanes one each.
    pub fixture_mcp: bool,
    pub platform: PlatformConfig,
}

#[derive(Debug, Clone)]
pub struct StagedFile {
    pub src: String,
    pub dest: String,
    pub mime_type: String,
}

#[derive(Debug, Clone)]
pub struct Stage {
    pub text: String,
    pub files: Vec<StagedFile>,
    /// Drive this stage (and the ones after it) in a fresh conversation rather than continuing the
    /// task's current one. Lets a task verify that files persist across conversations: a stage exports
    /// a file, then a later `new_conversation` stage rediscovers it from persistent storage.
    pub new_conversation: bool,
}

#[derive(Debug, Clone)]
pub struct Verifier {
    pub deps: Vec<String>,
    pub test_file: String,
    pub env: Vec<(String, String)>,
}

#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub dir: PathBuf,
    pub stages: Vec<Stage>,
    pub result_schema: serde_json::Value,
    pub verifier: Verifier,
    pub artifact_key: Option<String>,
    pub max_format_attempts: usize,
    pub state_rest: Vec<String>,
}

impl Task {
    pub fn inputs_dir(&self) -> PathBuf {
        self.dir.join("inputs")
    }

    pub fn expected_dir(&self) -> PathBuf {
        self.dir.join("expected")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_exposure_mode_serializes_to_backend_wire_strings() {
        assert_eq!(
            serde_json::to_value(ToolExposureMode::Full).unwrap(),
            serde_json::json!("full")
        );
        assert_eq!(
            serde_json::to_value(ToolExposureMode::SearchAndRunOnly).unwrap(),
            serde_json::json!("search_and_run_only")
        );
    }

    #[test]
    fn tool_exposure_mode_default_preserves_current_behavior() {
        assert_eq!(ToolExposureMode::default(), ToolExposureMode::SearchAndRunOnly);
    }

    #[test]
    fn tool_exposure_mode_from_str_roundtrips_and_rejects_unknown() {
        for mode in [ToolExposureMode::Full, ToolExposureMode::SearchAndRunOnly] {
            assert_eq!(ToolExposureMode::from_str(mode.as_str()).unwrap(), mode);
        }
        let err = ToolExposureMode::from_str("nope").unwrap_err();
        assert!(err.contains("nope"), "{err}");
    }
}
