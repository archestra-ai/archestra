use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;

use super::tasks::TaskConfigError;
use super::toml_util::{self, TomlTable};
use super::types::{EnvConfig, Mcp, PlatformConfig, SkillRef, ToolExposureMode};

// Empty by default: lanes mimic a regular Archestra user who sets no custom system prompt, so the
// agent runs on Archestra's stock chat instructions. Submission guidance is appended to the
// final-stage user message instead (see SUBMIT_INSTRUCTION in run.rs).
const DEFAULT_SYSTEM_PROMPT: &str = "";

#[derive(Debug, thiserror::Error)]
#[error("env config error: {0}")]
pub struct EnvConfigError(pub String);

impl From<toml_util::TomlError> for EnvConfigError {
    fn from(e: toml_util::TomlError) -> Self {
        Self(e.to_string())
    }
}

impl From<TaskConfigError> for EnvConfigError {
    fn from(e: TaskConfigError) -> Self {
        Self(e.to_string())
    }
}

pub fn load_envs(envs_dir: &Path) -> Result<HashMap<String, EnvConfig>, EnvConfigError> {
    let root = envs_dir
        .parent()
        .ok_or_else(|| EnvConfigError(format!("envs dir {envs_dir:?} has no parent")))?;

    let mut entries: Vec<_> = std::fs::read_dir(envs_dir)
        .map_err(|e| EnvConfigError(format!("cannot read envs dir: {e}")))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "toml"))
        .collect();
    entries.sort();

    if entries.is_empty() {
        return Err(EnvConfigError(format!(
            "no environment files found in {envs_dir:?}"
        )));
    }

    let mut envs: HashMap<String, EnvConfig> = HashMap::new();
    let mut task_owner: HashMap<String, String> = HashMap::new();

    for path in entries {
        let env = load_env(&path, root)?;
        if let Some(_prev) = envs.insert(env.id.clone(), env.clone()) {
            return Err(EnvConfigError(format!(
                "duplicate environment id {} (in {})",
                env.id,
                path.display()
            )));
        }
        for task in &env.tasks {
            if let Some(prev_env) = task_owner.insert(task.id.clone(), env.id.clone()) {
                return Err(EnvConfigError(format!(
                    "task id {} is defined in both {prev_env:?} and {:?}; task ids must be globally unique across environments",
                    task.id, env.id
                )));
            }
        }
    }

    Ok(envs)
}

fn load_env(path: &Path, root: &Path) -> Result<EnvConfig, EnvConfigError> {
    let ctx = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    let data = toml_util::parse_toml_file(path)?;

    let env_id = toml_util::req_str(&data, "id", &ctx)?;
    if !archestra_bench_core::is_slug(&env_id) {
        return Err(EnvConfigError(format!(
            "{ctx}: env id {env_id:?} must be lowercase alphanumeric with dashes (db-slug-safe)"
        )));
    }

    let name = toml_util::req_str_with_default(&data, "name", &ctx, &env_id)?;
    let agent = toml_util::table_with_default(&data, "agent", &ctx)?;
    let agent_ctx = format!("{ctx} [agent]");
    let agent_name =
        toml_util::req_str_with_default(&agent, "name", &agent_ctx, format!("{env_id}-agent"))?;
    let agent_prompt = toml_util::req_str_with_default(
        &agent,
        "system_prompt",
        &agent_ctx,
        DEFAULT_SYSTEM_PROMPT,
    )?;

    let skills = load_skills(&data, &ctx)?;
    let mcps = load_mcps(&data, &ctx)?;

    let task_ids = toml_util::strs(&data, "tasks", &ctx)?;
    if task_ids.is_empty() {
        return Err(EnvConfigError(format!(
            "{ctx}: environment {env_id:?} declares no tasks"
        )));
    }
    for task_id in &task_ids {
        if !archestra_bench_core::is_slug(task_id) {
            return Err(EnvConfigError(format!(
                "{ctx}: task id {task_id:?} must be lowercase alphanumeric with dashes (slug-safe)"
            )));
        }
    }

    let mut tasks = Vec::with_capacity(task_ids.len());
    for task_id in task_ids {
        let task_dir = root
            .join("tasks")
            .join(&task_id)
            .canonicalize()
            .map_err(|e| {
                EnvConfigError(format!(
                    "{ctx}: cannot resolve task dir for {task_id:?}: {e}"
                ))
            })?;
        tasks.push(super::tasks::load_task(&task_dir)?);
    }

    let tools = tool_names(
        &toml_util::strs(&data, "tools", &ctx)?,
        &format!("{ctx} tools"),
    )?;
    let share_backend = toml_util::opt_bool(&data, "share_backend", &ctx, false)?;
    let fixture_mcp = toml_util::opt_bool(&data, "fixture_mcp", &ctx, false)?;

    let platform = load_platform(&data, &ctx)?;

    Ok(EnvConfig {
        id: env_id,
        name,
        agent_name,
        agent_system_prompt: agent_prompt,
        skills,
        mcps,
        tasks,
        tools,
        share_backend,
        fixture_mcp,
        platform,
    })
}

fn load_platform(data: &TomlTable, ctx: &str) -> Result<PlatformConfig, EnvConfigError> {
    let platform = toml_util::table_with_default(data, "platform", ctx)?;
    let platform_ctx = format!("{ctx} [platform]");
    let mode = toml_util::req_str_with_default(
        &platform,
        "tool_exposure_mode",
        &platform_ctx,
        ToolExposureMode::default().as_str(),
    )?;
    let tool_exposure_mode = ToolExposureMode::from_str(&mode)
        .map_err(|e| EnvConfigError(format!("{platform_ctx}: {e}")))?;
    Ok(PlatformConfig { tool_exposure_mode })
}

fn load_skills(data: &TomlTable, ctx: &str) -> Result<Vec<SkillRef>, EnvConfigError> {
    let rows = toml_util::rows(data, "skills", ctx)?;
    let mut skills = Vec::with_capacity(rows.len());
    for (i, row) in rows.iter().enumerate() {
        let row_ctx = format!("{ctx} [[skills]][{i}]");
        skills.push(load_skill_ref(row, &row_ctx)?);
    }
    Ok(skills)
}

fn load_skill_ref(row: &TomlTable, ctx: &str) -> Result<SkillRef, EnvConfigError> {
    let cap = toml_util::opt_int(row, "cap", ctx)?.map(|c| c as usize);
    if let Some(c) = cap
        && c < 1
    {
        return Err(EnvConfigError(format!("{ctx}: cap must be >= 1, got {c}")));
    }
    let ref_ = toml_util::req_str(row, "ref", ctx)?;
    if ref_.contains('/') {
        return Err(EnvConfigError(format!(
            "{ctx}: ref {ref_:?} must not contain '/' (use a commit SHA or a slash-free tag)"
        )));
    }
    Ok(SkillRef {
        repo: toml_util::req_str(row, "repo", ctx)?,
        path: toml_util::opt_str(row, "path", ctx)?,
        ref_,
        cap,
    })
}

fn load_mcps(data: &TomlTable, ctx: &str) -> Result<Vec<Mcp>, EnvConfigError> {
    let rows = toml_util::rows(data, "mcps", ctx)?;
    let mut mcps = Vec::with_capacity(rows.len());
    let mut names = std::collections::HashSet::new();
    for (i, row) in rows.iter().enumerate() {
        let row_ctx = format!("{ctx} [[mcps]][{i}]");
        let name = toml_util::req_str(row, "name", &row_ctx)?;
        if !names.insert(name.clone()) {
            return Err(EnvConfigError(format!(
                "{row_ctx}: duplicate MCP name {name:?}"
            )));
        }
        mcps.push(Mcp {
            name,
            server_url: toml_util::req_str(row, "server_url", &row_ctx)?,
        });
    }
    Ok(mcps)
}

fn tool_names(names: &[String], ctx: &str) -> Result<Vec<String>, EnvConfigError> {
    for name in names {
        if name.is_empty() {
            return Err(EnvConfigError(format!(
                "{ctx}: tool name must be a lowercase archestra short name (e.g. create_skill)"
            )));
        }
        let mut chars = name.chars();
        if !chars.next().is_some_and(|c| c.is_ascii_lowercase()) {
            return Err(EnvConfigError(format!(
                "{ctx}: tool {name:?} must be a lowercase archestra short name (e.g. create_skill)"
            )));
        }
        if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') {
            return Err(EnvConfigError(format!(
                "{ctx}: tool {name:?} must be a lowercase archestra short name (e.g. create_skill)"
            )));
        }
    }
    let unique: std::collections::HashSet<_> = names.iter().collect();
    if unique.len() != names.len() {
        return Err(EnvConfigError(format!(
            "{ctx}: duplicate tool name(s) in {names:?}"
        )));
    }
    Ok(names.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_env(
        tmp: &std::path::Path,
        id: &str,
        tasks: &[&str],
        share_backend: bool,
        tools: &[&str],
    ) {
        let mut content = format!(
            r#"id = "{}"
name = "{}"
tasks = {:?}
share_backend = {}
"#,
            id, id, tasks, share_backend
        );
        if !tools.is_empty() {
            content.push_str(&format!("tools = {:?}\n", tools));
        }
        content.push_str("[agent]\nsystem_prompt = \"p\"\n");
        std::fs::write(tmp.join(format!("{id}.toml")), content).unwrap();
    }

    fn make_task_dir(root: &std::path::Path, task_id: &str) {
        let d = root.join("tasks").join(task_id);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(
            d.join("task.toml"),
            "[[stages]]\ntext = \"go\"\n[result_schema]\ntype = \"object\"\n",
        )
        .unwrap();
        std::fs::write(d.join("verifier.py"), "def test_ok(): assert True\n").unwrap();
    }

    #[test]
    fn test_load_envs_basic() {
        let tmp = tempfile::tempdir().unwrap();
        let envs_dir = tmp.path().join("envs");
        std::fs::create_dir(&envs_dir).unwrap();
        let tasks_dir = tmp.path().join("tasks");
        std::fs::create_dir(&tasks_dir).unwrap();
        write_env(&envs_dir, "basic", &["t1"], true, &[]);
        write_env(&envs_dir, "api", &["t2"], false, &["create_skill"]);
        make_task_dir(tmp.path(), "t1");
        make_task_dir(tmp.path(), "t2");
        let envs = load_envs(&envs_dir).unwrap();
        assert!(envs.contains_key("basic"));
        assert!(envs.contains_key("api"));
        assert!(envs["basic"].share_backend);
        assert!(!envs["api"].share_backend);
        assert_eq!(envs["api"].tools, vec!["create_skill"]);
    }

    // Write an env that declares task `t1` plus a verbatim `[platform]` fragment, then load it.
    fn load_env_with_platform(platform_fragment: &str) -> Result<EnvConfig, EnvConfigError> {
        let tmp = tempfile::tempdir().unwrap();
        make_task_dir(tmp.path(), "t1");
        let path = tmp.path().join("e.toml");
        let content = format!("id = \"e\"\nname = \"e\"\ntasks = [\"t1\"]\n{platform_fragment}");
        std::fs::write(&path, content).unwrap();
        load_env(&path, tmp.path())
    }

    #[test]
    fn test_platform_defaults_to_search_and_run_only() {
        let env = load_env_with_platform("").unwrap();
        assert_eq!(
            env.platform.tool_exposure_mode,
            ToolExposureMode::SearchAndRunOnly
        );
    }

    #[test]
    fn test_platform_full_is_parsed() {
        let env = load_env_with_platform("[platform]\ntool_exposure_mode = \"full\"\n").unwrap();
        assert_eq!(env.platform.tool_exposure_mode, ToolExposureMode::Full);
    }

    #[test]
    fn test_platform_unknown_mode_errors() {
        let err =
            load_env_with_platform("[platform]\ntool_exposure_mode = \"nope\"\n").unwrap_err();
        assert!(err.0.contains("tool_exposure_mode"), "{}", err.0);
        assert!(err.0.contains("nope"), "{}", err.0);
    }

    #[test]
    fn test_platform_non_string_mode_errors() {
        let err = load_env_with_platform("[platform]\ntool_exposure_mode = 7\n").unwrap_err();
        assert!(err.0.contains("must be a string"), "{}", err.0);
    }

    #[test]
    fn test_platform_non_table_errors() {
        let err = load_env_with_platform("platform = \"x\"\n").unwrap_err();
        assert!(err.0.contains("[platform] must be a table"), "{}", err.0);
    }

    #[test]
    fn test_fixture_mcp_parsed_in_both_modes() {
        let tmp = tempfile::tempdir().unwrap();
        let envs_dir = tmp.path().join("envs");
        std::fs::create_dir(&envs_dir).unwrap();
        make_task_dir(tmp.path(), "t1");
        make_task_dir(tmp.path(), "t2");

        // fixture_mcp = true with the default (isolated) backend loads and sets the flag.
        std::fs::write(
            envs_dir.join("isolated.toml"),
            "id = \"isolated\"\nname = \"isolated\"\ntasks = [\"t1\"]\nfixture_mcp = true\n",
        )
        .unwrap();
        // fixture_mcp together with share_backend also loads: the synthetic MCP is stateless, so the
        // shared backend starts one instance for all lanes.
        std::fs::write(
            envs_dir.join("shared.toml"),
            "id = \"shared\"\nname = \"shared\"\ntasks = [\"t2\"]\nfixture_mcp = true\nshare_backend = true\n",
        )
        .unwrap();
        let envs = load_envs(&envs_dir).unwrap();
        assert!(envs["isolated"].fixture_mcp);
        assert!(!envs["isolated"].share_backend);
        assert!(envs["shared"].fixture_mcp);
        assert!(envs["shared"].share_backend);
    }

    #[test]
    fn test_tool_names_rejects_non_short_name() {
        let err = tool_names(&["Create-Skill".to_string()], "ctx").unwrap_err();
        assert!(err.0.contains("short name"));
    }

    #[test]
    fn test_tool_names_rejects_duplicates() {
        let err = tool_names(
            &["create_skill".to_string(), "create_skill".to_string()],
            "ctx",
        )
        .unwrap_err();
        assert!(err.0.contains("duplicate"));
    }
}
