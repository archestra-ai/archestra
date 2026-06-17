use std::path::PathBuf;

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
