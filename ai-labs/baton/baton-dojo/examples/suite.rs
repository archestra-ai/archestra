//! Run the baton-dojo case suite and print the utility/security table.
//!
//! Each case (see `baton_dojo::scenarios`) is run twice — with the baton gate off
//! and on — so the table shows what the gate changed: it should drive `leak`
//! toward 0 while keeping `utility` up.
//!
//! Run: `OPENROUTER_API_KEY=... cargo run -p baton-dojo --example suite`
//! (or put the key in `ai-labs/.env`). Override the model with `DOJO_MODEL`.

use std::path::Path;

use baton_dojo::{DojoError, model, scenarios, suite};

#[tokio::main]
async fn main() -> Result<(), DojoError> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(std::io::stderr)
        .init();

    let Some(api_key) = resolve_api_key() else {
        eprintln!("set OPENROUTER_API_KEY (or add it to ai-labs/.env) to run the suite");
        return Ok(());
    };
    let model_id = std::env::var("DOJO_MODEL").unwrap_or_else(|_| "openai/gpt-4o-mini".to_owned());
    let model = model::with_key(&model_id, &api_key)?;

    println!("model: {model_id}\nrunning cases (each: gate off, then gate on)...\n");

    // The cases have different workspace types, so they're listed rather than
    // looped; each `run` returns the same workspace-free `CaseReport`.
    let reports = vec![
        scenarios::mailbox()?.run(&model).await?,
        scenarios::recording()?.run(&model).await?,
        scenarios::auditor()?.run(&model).await?,
    ];

    print!("{}", suite::report_table(&reports));
    Ok(())
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
