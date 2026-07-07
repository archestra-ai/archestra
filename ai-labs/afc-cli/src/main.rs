//! `afc` — the AFC prototype CLI: check, review, bootstrap, suggest, demo.

use std::path::PathBuf;
use std::process::ExitCode;

use afc_core::checker::{CheckReport, Inventory, Severity, check};
use afc_core::engine::{AllowVia, Decision};
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(
    name = "afc",
    about = "AFC — information-flow control for agent tool calls (demo)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Statically check a policy file for leaks, type errors, and unlabeled tools.
    Check {
        /// Policy file (defaults to the bundled demo policy).
        #[arg(long)]
        config: Option<PathBuf>,
        /// The caller's last-seen inventory hash; a mismatch reports that the inventory changed.
        #[arg(long)]
        inventory_hash: Option<String>,
    },
    /// Review bootstrap proposals non-interactively.
    Review {
        #[arg(long)]
        approve_all: bool,
        /// Tools to leave unreviewed (repeatable).
        #[arg(long = "except")]
        except: Vec<String>,
    },
    /// Load fixture annotation proposals (no LLM call).
    Bootstrap,
    /// Read a decision log and emit improvement suggestions.
    Suggest {
        #[arg(long)]
        log: Option<PathBuf>,
    },
    /// Run the scripted scenario and print the annotated trace.
    Demo {
        #[arg(long)]
        log: Option<PathBuf>,
    },
}

fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Check {
            config,
            inventory_hash,
        } => cmd_check(config, inventory_hash),
        Command::Review {
            approve_all,
            except,
        } => cmd_review(approve_all, except),
        Command::Bootstrap => cmd_bootstrap(),
        Command::Suggest { log } => cmd_suggest(log),
        Command::Demo { log } => cmd_demo(log),
    }
}

fn cmd_check(config: Option<PathBuf>, inventory_hash: Option<String>) -> ExitCode {
    let config = config.unwrap_or_else(afc_demo::default_policy_path);
    let inv = match afc_demo::build_inventory(&config) {
        Ok(inv) => inv,
        Err(e) => {
            eprintln!("failed to load config: {e}");
            return ExitCode::FAILURE;
        }
    };

    let computed = inventory_hash_of(&inv);
    match inventory_hash {
        Some(given) if given != computed => {
            println!("inventory hash changed (was {given}, now {computed}) — re-running check");
        }
        Some(_) => println!("inventory hash unchanged ({computed}) — re-running check"),
        None => println!("inventory hash {computed}"),
    }

    let report = check(&inv);
    print_report(&report);
    if report.has_errors() {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn print_report(report: &CheckReport) {
    println!("\n== afc check report ==");
    println!("rules: {}", report.rule_count);
    println!("tools: {}", report.tool_count);
    println!("unlabeled (Unknown) tools: {}", report.unlabeled_count);
    println!("active assumes: {}", report.assume_count);
    println!(
        "estimated human-escalation surface: {} path(s)",
        report.escalation_surface
    );
    if report.findings.is_empty() {
        println!("findings: none");
        return;
    }
    println!("findings:");
    for f in &report.findings {
        let tag = match f.severity {
            Severity::Error => "ERROR",
            Severity::Warn => "warn",
            Severity::Info => "info",
        };
        println!("  [{tag}] {} — {}", f.code, f.message);
    }
}

fn cmd_review(_approve_all: bool, except: Vec<String>) -> ExitCode {
    let source = afc_demo::bootstrap::FixtureProposalSource::new(afc_demo::proposals_fixture());
    let proposals = match proposals(&source) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    let reviewed = afc_demo::bootstrap::review(&proposals, &except);
    println!("== afc review (approve-all, except {except:?}) ==");
    for p in &reviewed {
        let status = p.reviewed_by.as_deref().unwrap_or("UNREVIEWED");
        println!(
            "  {} effects={:?} reviewed_by={}",
            p.tool, p.effects, status
        );
    }
    ExitCode::SUCCESS
}

fn cmd_bootstrap() -> ExitCode {
    let source = afc_demo::bootstrap::FixtureProposalSource::new(afc_demo::proposals_fixture());
    let proposals = match proposals(&source) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };
    println!("== afc bootstrap (fixture proposals, no LLM) ==");
    for p in &proposals {
        println!(
            "  {} effects={:?} proposed_by={:?} confidence={:?} reviewed_by={:?}",
            p.tool, p.effects, p.proposed_by, p.confidence, p.reviewed_by
        );
    }
    ExitCode::SUCCESS
}

fn cmd_suggest(log: Option<PathBuf>) -> ExitCode {
    let (records, _guard) = match log {
        Some(path) => match afc_demo::suggest::read_log(&path) {
            Ok(r) => (r, None),
            Err(e) => {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
        },
        None => {
            // No log given — run the scenario to a temp log so suggest has something to read.
            let dir = std::env::temp_dir().join("afc-suggest.jsonl");
            if let Err(e) =
                afc_demo::run_scenario(&afc_demo::default_policy_path(), Some(dir.clone()))
            {
                eprintln!("{e}");
                return ExitCode::FAILURE;
            }
            match afc_demo::suggest::read_log(&dir) {
                Ok(r) => (r, Some(dir)),
                Err(e) => {
                    eprintln!("{e}");
                    return ExitCode::FAILURE;
                }
            }
        }
    };
    println!("== afc suggest ==");
    for s in afc_demo::suggest::suggest(&records) {
        println!("  [{}] {}", s.pattern, s.message);
    }
    ExitCode::SUCCESS
}

fn cmd_demo(log: Option<PathBuf>) -> ExitCode {
    let jsonl = log.unwrap_or_else(|| std::env::temp_dir().join("afc-demo.jsonl"));
    let s = match afc_demo::run_scenario(&afc_demo::default_policy_path(), Some(jsonl.clone())) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("scenario failed: {e}");
            return ExitCode::FAILURE;
        }
    };

    println!("== afc demo — annotated trace ==\n");
    println!(
        "1. read doc A            → labeled {}",
        render_readers(&s.beat1_read.label.readers)
    );
    println!("2. summarize → write B   → {}", render(&s.beat2_deny));
    println!(
        "3. declassify → write B  → declassified={} {}",
        s.beat3_declassified_ok,
        render(&s.beat3_allow)
    );
    println!("4. web.fetch → email.send→ {}", render(&s.beat4_escalate));
    println!(
        "     llm abstains(tainted)={} → human approves → {}",
        s.beat4_llm_abstained,
        render(&s.beat4_final)
    );
    println!("5. crm.export(region=EU) → {}", render(&s.beat5_deny));
    println!("6. legacy.dump → egress  → {}", render(&s.beat6_deny));
    println!("7. injection replay      → {}", render(&s.beat7_deny));
    println!(
        "     llm abstains={} declassify refused={}  \"succeeds at persuasion, fails at flow\"",
        s.beat7_llm_abstains, s.beat7_declass_refused
    );
    println!("8. risk_bert tighten     → {}", render(&s.beat8_risk_deny));
    println!("     owner→org hook       → {:?}", s.beat8_hook_verdict);
    println!("\ndecision log: {}", jsonl.display());
    ExitCode::SUCCESS
}

fn render(d: &Decision) -> String {
    match d {
        Decision::Allow { via: None, .. } => "Allow".to_string(),
        Decision::Allow {
            via: Some(AllowVia::ApprovedBy(c)),
            ..
        } => format!("Allow (approved via {c})"),
        Decision::Allow {
            via: Some(AllowVia::DeclassifiedBy(d)),
            ..
        } => format!("Allow (declassified by {d})"),
        Decision::Deny { rule_id, .. } => format!("Deny ({rule_id})"),
        Decision::Escalate { chain, .. } => format!("Escalate → {chain:?}"),
    }
}

fn render_readers(r: &afc_core::label::Readers) -> String {
    match r {
        afc_core::label::Readers::Unknown => "readers: Unknown".to_string(),
        afc_core::label::Readers::Known(s) => format!("readers: {s:?}"),
    }
}

fn proposals(
    source: &afc_demo::bootstrap::FixtureProposalSource,
) -> Result<Vec<afc_demo::bootstrap::Proposal>, String> {
    use afc_demo::bootstrap::ProposalSource;
    source.propose()
}

/// A stable FNV-1a hash over the compiled rule and tool ids — the inventory's identity for the
/// `--inventory-hash` re-check trigger.
fn inventory_hash_of(inv: &Inventory) -> String {
    let mut ids: Vec<String> = inv.rules.iter().map(|r| r.id.clone()).collect();
    ids.extend(inv.tools.iter().map(|t| t.id.clone()));
    ids.sort();
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in ids.join("|").bytes() {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
