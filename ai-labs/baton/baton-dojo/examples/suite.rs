//! Run the baton-dojo case suite and print the utility/security table.
//!
//! ```text
//! cargo run -p baton-dojo --example suite                      # all cases, both modes (base → security)
//! cargo run -p baton-dojo --example suite -- mailbox_exfil     # one case, both modes
//! cargo run -p baton-dojo --example suite -- all security      # all cases, one mode
//! cargo run -p baton-dojo --example suite -- mailbox_exfil base
//! ```
//!
//! `base` = undefended (no baton gate); `security` = baton-defended. Needs
//! `OPENROUTER_API_KEY` (or a line in `ai-labs/.env`); `DOJO_MODEL` picks the model.

use std::path::Path;

use baton_dojo::{CaseReport, DojoError, Mode, Model, Scores, model, scenarios, suite};

/// Every case name the runner knows (kept in sync with the match arms below).
const CASES: &[&str] = &["mailbox_exfil", "recording_to_public", "invoice_to_auditor"];

#[tokio::main]
async fn main() -> Result<(), DojoError> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let case_sel = args.first().map(String::as_str).unwrap_or("all");
    let mode_sel = args.get(1).map(String::as_str);

    // Which cases to run.
    let selected: Vec<&'static str> = if case_sel == "all" {
        CASES.to_vec()
    } else if let Some(&c) = CASES.iter().find(|&&c| c == case_sel) {
        vec![c]
    } else {
        eprintln!("unknown case `{case_sel}`. known: {CASES:?}, or `all`");
        return Ok(());
    };

    // Which mode(s): a named mode, or None = both.
    let mode = match mode_sel {
        None => None,
        Some(m) => match Mode::parse(m) {
            Some(mode) => Some(mode),
            None => {
                eprintln!("unknown mode `{m}`. use `base` or `security`");
                return Ok(());
            }
        },
    };

    let Some(api_key) = resolve_api_key() else {
        eprintln!("set OPENROUTER_API_KEY (or add it to ai-labs/.env) to run the suite");
        return Ok(());
    };
    let model_id = std::env::var("DOJO_MODEL").unwrap_or_else(|_| "openai/gpt-4o-mini".to_owned());
    let model = model::with_key(&model_id, &api_key)?;
    println!("model: {model_id}\n");

    match mode {
        // Both modes: the base → security transition table.
        None => {
            let mut reports = Vec::new();
            for name in selected {
                reports.push(run_named(&model, name).await?);
            }
            print!("{}", suite::report_table(&reports));
        }
        // A single mode: one row per case.
        Some(mode) => {
            let mut rows = Vec::new();
            for name in selected {
                rows.push((name, mode, score_named(&model, name, mode).await?));
            }
            print!("{}", suite::mode_table(&rows));
        }
    }
    Ok(())
}

/// Score a case (by name) in both modes.
async fn run_named(model: &Model, name: &str) -> Result<CaseReport, DojoError> {
    Ok(match name {
        "mailbox_exfil" => scenarios::mailbox()?.run(model).await?,
        "recording_to_public" => scenarios::recording()?.run(model).await?,
        "invoice_to_auditor" => scenarios::auditor()?.run(model).await?,
        other => unreachable!("case `{other}` is validated against CASES before dispatch"),
    })
}

/// Score a case (by name) in one mode.
async fn score_named(model: &Model, name: &str, mode: Mode) -> Result<Scores, DojoError> {
    Ok(match name {
        "mailbox_exfil" => scenarios::mailbox()?.score(model, mode).await?,
        "recording_to_public" => scenarios::recording()?.score(model, mode).await?,
        "invoice_to_auditor" => scenarios::auditor()?.score(model, mode).await?,
        other => unreachable!("case `{other}` is validated against CASES before dispatch"),
    })
}

/// `OPENROUTER_API_KEY` from the environment, else from `ai-labs/.env`.
fn resolve_api_key() -> Option<String> {
    if let Ok(key) = std::env::var("OPENROUTER_API_KEY")
        && !key.is_empty()
    {
        return Some(key);
    }
    let env_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env");
    let contents = std::fs::read_to_string(env_path).ok()?;
    contents.lines().find_map(|line| {
        let value = line
            .trim()
            .strip_prefix("OPENROUTER_API_KEY=")?
            .trim()
            .trim_matches('"');
        (!value.is_empty()).then(|| value.to_owned())
    })
}
