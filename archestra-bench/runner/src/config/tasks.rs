use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use super::toml_util::{self, TomlTable};
use super::types::{Stage, StagedFile, Task, Verifier};

static FILE_PLACEHOLDER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{file:([^}]+)\}\}").expect("valid regex"));
const DEFAULT_MAX_FORMAT_ATTEMPTS: i64 = 3;

#[derive(Debug, thiserror::Error)]
#[error("task config error: {0}")]
pub struct TaskConfigError(pub String);

impl From<toml_util::TomlError> for TaskConfigError {
    fn from(e: toml_util::TomlError) -> Self {
        Self(e.to_string())
    }
}

pub fn load_task(task_dir: &Path) -> Result<Task, TaskConfigError> {
    let task_id = task_dir
        .file_name()
        .ok_or_else(|| TaskConfigError("task dir has no name".to_string()))?
        .to_string_lossy()
        .to_string();
    let ctx = format!("task {task_id:?}");

    if !archestra_bench_core::is_slug(&task_id) {
        return Err(TaskConfigError(format!(
            "{ctx}: task dir name must be lowercase alphanumeric with dashes (slug-safe)"
        )));
    }

    let toml_path = task_dir.join("task.toml");
    if !toml_path.is_file() {
        return Err(TaskConfigError(format!("{ctx}: missing {toml_path:?}")));
    }

    let data = toml_util::parse_toml_file(&toml_path)?;

    let stage_rows = toml_util::rows(&data, "stages", &ctx)?;
    if stage_rows.is_empty() {
        return Err(TaskConfigError(format!("{ctx}: task declares no stages")));
    }
    let mut stages = Vec::with_capacity(stage_rows.len());
    for (i, row) in stage_rows.iter().enumerate() {
        let row_ctx = format!("{ctx} [[stages]][{i}]");
        let stage = load_stage(row, &row_ctx, task_dir)?;
        if i == 0 && stage.new_conversation {
            return Err(TaskConfigError(format!(
                "{row_ctx}: the first stage cannot set new_conversation; the initial conversation is \
                 created automatically"
            )));
        }
        stages.push(stage);
    }

    let schema = toml_util::table(&data, "result_schema", &ctx)?;
    let schema_value = toml_table_to_json_value(&schema);

    let max_attempts = toml_util::req_int(
        &data,
        "max_format_attempts",
        &ctx,
        DEFAULT_MAX_FORMAT_ATTEMPTS,
    )? as usize;
    if max_attempts < 1 {
        return Err(TaskConfigError(format!(
            "{ctx}: max_format_attempts must be >= 1, got {max_attempts}"
        )));
    }

    let verifier_table = toml_util::table_with_default(&data, "verifier", &ctx)?;
    let verifier = load_verifier(&verifier_table, &format!("{ctx} [verifier]"), task_dir)?;

    let state_table = toml_util::table_with_default(&data, "state", &ctx)?;
    let state_rest = load_state_rest(&state_table, &format!("{ctx} [state]"))?;

    Ok(Task {
        id: task_id,
        dir: task_dir.to_path_buf(),
        stages,
        result_schema: schema_value,
        verifier,
        artifact_key: toml_util::opt_str(&data, "artifact_key", &ctx)?,
        max_format_attempts: max_attempts,
        state_rest,
    })
}

fn load_stage(row: &TomlTable, ctx: &str, task_dir: &Path) -> Result<Stage, TaskConfigError> {
    let text = toml_util::req_str(row, "text", ctx)?;
    let text = expand_files(&text, task_dir, ctx)?;
    let files = load_staged_files(row, ctx, &task_dir.join("inputs"))?;
    let new_conversation = toml_util::opt_bool(row, "new_conversation", ctx, false)?;
    Ok(Stage {
        text,
        files,
        new_conversation,
    })
}

fn expand_files(text: &str, task_dir: &Path, ctx: &str) -> Result<String, TaskConfigError> {
    let base = task_dir;
    let mut errors = Vec::new();
    let result = FILE_PLACEHOLDER.replace_all(text, |caps: &regex::Captures| {
        let rel = caps[1].trim();
        let target = match resolve_under(base, rel) {
            Ok(t) => t,
            Err(e) => {
                errors.push(e);
                return "".to_string();
            }
        };
        if !target.is_file() {
            errors.push(format!("{ctx}: file placeholder {rel:?} does not exist"));
            return "".to_string();
        }
        match std::fs::read_to_string(&target) {
            Ok(s) => s,
            Err(e) => {
                errors.push(format!("{ctx}: cannot read file placeholder {rel:?}: {e}"));
                "".to_string()
            }
        }
    });
    if !errors.is_empty() {
        return Err(TaskConfigError(errors.into_iter().next().unwrap()));
    }
    Ok(result.into_owned())
}

fn load_staged_files(
    row: &TomlTable,
    ctx: &str,
    inputs_dir: &Path,
) -> Result<Vec<StagedFile>, TaskConfigError> {
    let rows = toml_util::rows(row, "files", ctx)?;
    let mut files = Vec::with_capacity(rows.len());
    for (i, file_row) in rows.iter().enumerate() {
        let file_ctx = format!("{ctx} [[files]][{i}]");
        let src = toml_util::req_str(file_row, "src", &file_ctx)?;
        check_under_inputs(&src, inputs_dir, &file_ctx)?;
        files.push(StagedFile {
            src,
            dest: toml_util::req_str(file_row, "dest", &file_ctx)?,
            mime_type: toml_util::req_str_with_default(
                file_row,
                "mime_type",
                &file_ctx,
                "application/octet-stream",
            )?,
        });
    }
    Ok(files)
}

fn check_under_inputs(src: &str, inputs_dir: &Path, ctx: &str) -> Result<(), TaskConfigError> {
    if src.starts_with('/') {
        return Err(TaskConfigError(format!(
            "{ctx}: staged file src {src:?} must be relative (under inputs/)"
        )));
    }
    let target = resolve_under(inputs_dir, src).map_err(TaskConfigError)?;
    if !target.is_file() {
        return Err(TaskConfigError(format!(
            "{ctx}: staged file {target:?} does not exist"
        )));
    }
    Ok(())
}

fn resolve_under(base: &Path, rel: &str) -> Result<PathBuf, String> {
    let target = base.join(rel);
    let target = target
        .canonicalize()
        .map_err(|e| format!("cannot resolve {rel:?}: {e}"))?;
    let base_canon = base
        .canonicalize()
        .map_err(|e| format!("cannot resolve base dir: {e}"))?;
    if target != base_canon && !target.starts_with(&base_canon) {
        return Err(format!("path {rel:?} escapes base directory"));
    }
    Ok(target)
}

fn load_verifier(tbl: &TomlTable, ctx: &str, task_dir: &Path) -> Result<Verifier, TaskConfigError> {
    let test_file = toml_util::req_str_with_default(tbl, "test_file", ctx, "verifier.py")?;
    if test_file.starts_with('/') {
        return Err(TaskConfigError(format!(
            "{ctx}: test_file {test_file:?} must be relative (under the task dir)"
        )));
    }
    let target = resolve_under(task_dir, &test_file).map_err(|e| {
        TaskConfigError(format!(
            "{ctx}: test_file {test_file:?} escapes the task dir: {e}"
        ))
    })?;
    if !target.is_file() {
        return Err(TaskConfigError(format!(
            "{ctx}: verifier {target:?} does not exist"
        )));
    }
    Ok(Verifier {
        deps: toml_util::strs(tbl, "deps", ctx)?,
        test_file,
        env: toml_util::str_map(tbl, "env", ctx)?,
    })
}

fn load_state_rest(tbl: &TomlTable, ctx: &str) -> Result<Vec<String>, TaskConfigError> {
    let paths = toml_util::strs(tbl, "rest", ctx)?;
    for p in &paths {
        validate_state_path(p, ctx)?;
    }
    Ok(paths)
}

fn validate_state_path(path: &str, ctx: &str) -> Result<(), TaskConfigError> {
    // Validate the *path* component (query strings and the {{cell}}/{{agent_id}} placeholders are
    // substituted later and allowed), and decode percent-escapes before the `..` check so
    // `/api/%2e%2e/x` is rejected just like `/api/../x`.
    let path_part = path.split('?').next().unwrap_or(path);
    if path_part.contains("://") || path_part.starts_with("//") {
        return Err(TaskConfigError(format!(
            "{ctx}: rest path {path:?} must be a relative /api/ path, not an absolute URL"
        )));
    }
    if !path_part.starts_with("/api/") {
        return Err(TaskConfigError(format!(
            "{ctx}: rest path {path:?} must start with /api/"
        )));
    }
    let decoded = percent_encoding::percent_decode_str(path_part)
        .decode_utf8_lossy()
        .into_owned();
    if decoded.split('/').any(|seg| seg == "..") {
        return Err(TaskConfigError(format!(
            "{ctx}: rest path {path:?} must not contain a '..' segment"
        )));
    }
    Ok(())
}

fn toml_table_to_json_value(table: &TomlTable) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (k, v) in table {
        map.insert(k.clone(), toml_value_to_json_value(v));
    }
    serde_json::Value::Object(map)
}

fn toml_value_to_json_value(value: &toml::Value) -> serde_json::Value {
    match value {
        toml::Value::String(s) => serde_json::Value::String(s.clone()),
        toml::Value::Integer(i) => serde_json::Value::Number((*i).into()),
        toml::Value::Float(f) => serde_json::Number::from_f64(*f)
            .map_or(serde_json::Value::Null, serde_json::Value::Number),
        toml::Value::Boolean(b) => serde_json::Value::Bool(*b),
        toml::Value::Datetime(d) => serde_json::Value::String(d.to_string()),
        toml::Value::Array(arr) => {
            serde_json::Value::Array(arr.iter().map(toml_value_to_json_value).collect())
        }
        toml::Value::Table(t) => toml_table_to_json_value(t),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn state_path_accepts_api_path_with_query_and_placeholders() {
        validate_state_path("/api/skills?search=prime-counter-{{cell}}&limit=100", "ctx").unwrap();
        validate_state_path("/api/agents/{{agent_id}}/tools", "ctx").unwrap();
    }

    #[test]
    fn state_path_rejects_plain_and_encoded_traversal() {
        assert!(validate_state_path("/api/../x", "ctx").is_err());
        assert!(validate_state_path("/api/%2e%2e/x", "ctx").is_err());
        assert!(validate_state_path("/api/%2E%2E/x", "ctx").is_err());
    }

    #[test]
    fn state_path_rejects_non_api_and_absolute_url() {
        assert!(validate_state_path("/other", "ctx").is_err());
        assert!(validate_state_path("http://host/api/x", "ctx").is_err());
        assert!(validate_state_path("//host/api/x", "ctx").is_err());
    }

    /// Write a minimal slug-named task dir (verifier + result_schema) with the given `[[stages]]`
    /// TOML, returning the temp dir whose `sample-task` child is the loadable task dir.
    fn write_task(stages_toml: &str) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("sample-task");
        std::fs::create_dir(&dir).unwrap();
        std::fs::write(dir.join("verifier.py"), "def test_ok(): assert True\n").unwrap();
        std::fs::write(
            dir.join("task.toml"),
            format!("{stages_toml}\n[result_schema]\ntype = \"object\"\n"),
        )
        .unwrap();
        tmp
    }

    #[test]
    fn stage_new_conversation_defaults_false() {
        let tmp = write_task("[[stages]]\ntext = \"go\"\n");
        let task = load_task(&tmp.path().join("sample-task")).unwrap();
        assert_eq!(task.stages.len(), 1);
        assert!(!task.stages[0].new_conversation);
    }

    #[test]
    fn stage_new_conversation_parsed_on_later_stage() {
        let tmp = write_task(
            "[[stages]]\ntext = \"a\"\n\n[[stages]]\ntext = \"b\"\nnew_conversation = true\n",
        );
        let task = load_task(&tmp.path().join("sample-task")).unwrap();
        assert!(!task.stages[0].new_conversation);
        assert!(task.stages[1].new_conversation);
    }

    #[test]
    fn stage_new_conversation_rejected_on_first_stage() {
        let tmp = write_task("[[stages]]\ntext = \"a\"\nnew_conversation = true\n");
        let err = load_task(&tmp.path().join("sample-task")).unwrap_err();
        assert!(
            err.to_string()
                .contains("first stage cannot set new_conversation"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn stage_new_conversation_rejects_non_bool() {
        let tmp = write_task(
            "[[stages]]\ntext = \"a\"\n\n[[stages]]\ntext = \"b\"\nnew_conversation = \"yes\"\n",
        );
        let err = load_task(&tmp.path().join("sample-task")).unwrap_err();
        assert!(
            err.to_string().contains("new_conversation"),
            "unexpected error: {err}"
        );
    }
}
