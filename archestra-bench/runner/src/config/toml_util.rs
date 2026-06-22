pub type TomlTable = toml::map::Map<String, toml::Value>;

#[derive(Debug, thiserror::Error)]
#[error("{ctx}: {message}")]
pub struct TomlError {
    pub ctx: String,
    pub message: String,
}

impl TomlError {
    pub fn new(ctx: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            ctx: ctx.into(),
            message: message.into(),
        }
    }
}

pub type TomlResult<T> = Result<T, TomlError>;

pub fn parse_toml_file(path: &std::path::Path) -> TomlResult<TomlTable> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| TomlError::new(format!("{}", path.display()), format!("cannot read: {e}")))?;
    parse_toml_text(&text, path)
}

pub fn parse_toml_text(text: &str, path: &std::path::Path) -> TomlResult<TomlTable> {
    match text.parse::<toml::Value>() {
        Ok(toml::Value::Table(t)) => Ok(t),
        Ok(_) => Err(TomlError::new(
            format!("{}", path.display()),
            "TOML root must be a table",
        )),
        Err(e) => Err(TomlError::new(
            format!("{}", path.display()),
            format!("cannot parse TOML: {e}"),
        )),
    }
}

pub fn req_str(value: &TomlTable, key: &str, ctx: &str) -> TomlResult<String> {
    match value.get(key) {
        Some(toml::Value::String(s)) => Ok(s.clone()),
        Some(other) => Err(TomlError::new(
            ctx,
            format!("{key:?} must be a string, got {}", type_name(other)),
        )),
        None => Err(TomlError::new(
            ctx,
            format!("missing required string {key:?}"),
        )),
    }
}

pub fn req_str_with_default(
    value: &TomlTable,
    key: &str,
    ctx: &str,
    default: impl Into<String>,
) -> TomlResult<String> {
    match value.get(key) {
        Some(toml::Value::String(s)) => Ok(s.clone()),
        Some(other) => Err(TomlError::new(
            ctx,
            format!("{key:?} must be a string, got {}", type_name(other)),
        )),
        None => Ok(default.into()),
    }
}

pub fn opt_str(value: &TomlTable, key: &str, ctx: &str) -> TomlResult<Option<String>> {
    match value.get(key) {
        Some(toml::Value::String(s)) => Ok(Some(s.clone())),
        Some(other) => Err(TomlError::new(
            ctx,
            format!("{key:?} must be a string, got {}", type_name(other)),
        )),
        None => Ok(None),
    }
}

pub fn req_int(value: &TomlTable, key: &str, ctx: &str, default: i64) -> TomlResult<i64> {
    match value.get(key) {
        Some(toml::Value::Integer(i)) => Ok(*i),
        Some(other) => Err(TomlError::new(
            ctx,
            format!("{key:?} must be an integer, got {}", type_name(other)),
        )),
        None => Ok(default),
    }
}

pub fn opt_int(value: &TomlTable, key: &str, ctx: &str) -> TomlResult<Option<i64>> {
    match value.get(key) {
        Some(toml::Value::Integer(i)) => Ok(Some(*i)),
        Some(other) => Err(TomlError::new(
            ctx,
            format!("{key:?} must be an integer, got {}", type_name(other)),
        )),
        None => Ok(None),
    }
}

pub fn opt_bool(value: &TomlTable, key: &str, ctx: &str, default: bool) -> TomlResult<bool> {
    match value.get(key) {
        Some(toml::Value::Boolean(b)) => Ok(*b),
        Some(other) => Err(TomlError::new(
            ctx,
            format!("{key:?} must be a boolean, got {}", type_name(other)),
        )),
        None => Ok(default),
    }
}

pub fn table(value: &TomlTable, key: &str, ctx: &str) -> TomlResult<TomlTable> {
    match value.get(key) {
        Some(toml::Value::Table(t)) => Ok(t.clone()),
        Some(other) => Err(TomlError::new(
            ctx,
            format!("[{key}] must be a table, got {}", type_name(other)),
        )),
        None => Err(TomlError::new(
            ctx,
            format!("missing required table [{key}]"),
        )),
    }
}

pub fn table_with_default(value: &TomlTable, key: &str, ctx: &str) -> TomlResult<TomlTable> {
    match value.get(key) {
        Some(toml::Value::Table(t)) => Ok(t.clone()),
        Some(other) => Err(TomlError::new(
            ctx,
            format!("[{key}] must be a table, got {}", type_name(other)),
        )),
        None => Ok(TomlTable::new()),
    }
}

pub fn rows(value: &TomlTable, key: &str, ctx: &str) -> TomlResult<Vec<TomlTable>> {
    match value.get(key) {
        Some(toml::Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for item in arr {
                match item {
                    toml::Value::Table(t) => out.push(t.clone()),
                    other => {
                        return Err(TomlError::new(
                            ctx,
                            format!(
                                "[[{key}]] must be an array of tables, got {}",
                                type_name(other)
                            ),
                        ));
                    }
                }
            }
            Ok(out)
        }
        Some(other) => Err(TomlError::new(
            ctx,
            format!(
                "[[{key}]] must be an array of tables, got {}",
                type_name(other)
            ),
        )),
        None => Ok(Vec::new()),
    }
}

pub fn strs(value: &TomlTable, key: &str, ctx: &str) -> TomlResult<Vec<String>> {
    match value.get(key) {
        Some(toml::Value::Array(arr)) => {
            let mut out = Vec::with_capacity(arr.len());
            for (i, item) in arr.iter().enumerate() {
                match item {
                    toml::Value::String(s) => out.push(s.clone()),
                    other => {
                        return Err(TomlError::new(
                            ctx,
                            format!("{key:?}[{i}] must be a string, got {}", type_name(other)),
                        ));
                    }
                }
            }
            Ok(out)
        }
        Some(other) => Err(TomlError::new(
            ctx,
            format!(
                "{key:?} must be an array of strings, got {}",
                type_name(other)
            ),
        )),
        None => Ok(Vec::new()),
    }
}

pub fn str_map(value: &TomlTable, key: &str, ctx: &str) -> TomlResult<Vec<(String, String)>> {
    match value.get(key) {
        Some(toml::Value::Table(t)) => {
            let mut out = Vec::with_capacity(t.len());
            for (k, v) in t {
                match v {
                    toml::Value::String(s) => out.push((k.clone(), s.clone())),
                    other => {
                        return Err(TomlError::new(
                            ctx,
                            format!("[{key}].{k} must be a string, got {}", type_name(other)),
                        ));
                    }
                }
            }
            Ok(out)
        }
        Some(other) => Err(TomlError::new(
            ctx,
            format!(
                "[{key}] must be a table of string values, got {}",
                type_name(other)
            ),
        )),
        None => Ok(Vec::new()),
    }
}

fn type_name(value: &toml::Value) -> &'static str {
    match value {
        toml::Value::String(_) => "string",
        toml::Value::Integer(_) => "integer",
        toml::Value::Float(_) => "float",
        toml::Value::Boolean(_) => "boolean",
        toml::Value::Datetime(_) => "datetime",
        toml::Value::Array(_) => "array",
        toml::Value::Table(_) => "table",
    }
}
