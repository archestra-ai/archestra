//! Stateless policy check over baton-core.
//!
//! Reads one JSON request from stdin, replays the episode, checks the
//! proposed call, prints one JSON decision to stdout. Exit 0 with a decision;
//! exit 2 with `{"error": …}` on malformed input or a protocol violation
//! (see [`protocol::run`]).

mod protocol;

use std::io::Read;
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut raw = String::new();
    if let Err(error) = std::io::stdin().read_to_string(&mut raw) {
        return fail(&format!("reading stdin: {error}"));
    }
    let input: protocol::Input = match serde_json::from_str(&raw) {
        Ok(input) => input,
        Err(error) => return fail(&format!("parsing input: {error}")),
    };
    match protocol::run(&input) {
        Ok(output) => {
            println!(
                "{}",
                serde_json::to_string(&output).expect("output serializes")
            );
            ExitCode::SUCCESS
        }
        Err(error) => fail(&error.to_string()),
    }
}

fn fail(error: &str) -> ExitCode {
    println!("{}", serde_json::json!({ "error": error }));
    ExitCode::from(2)
}
