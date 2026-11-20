use axum::{Json, Router, extract::DefaultBodyLimit, routing::post};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub(crate) fn router() -> Router {
    Router::new()
        .route("/internal/v1/openai/tool-release", post(plan))
        .route(
            "/internal/v1/openai/policy-sse",
            post(crate::openai_sse::policy_output),
        )
        .route(
            "/internal/v1/openai/receipt-prefix-sse",
            post(crate::openai_sse::receipt_prefix),
        )
        .route("/internal/v1/openai/policy-order", post(policy_order))
        .route(
            "/internal/v1/openai/policy-finalizer",
            post(policy_finalizer),
        )
        .layer(DefaultBodyLimit::max(72 * 1024 * 1024))
}

#[derive(Serialize)]
struct PolicyOrder {
    rewrite: Vec<usize>,
    prepare: Vec<usize>,
    finalize: Vec<usize>,
}

async fn policy_order(Json(finalizes): Json<Vec<bool>>) -> Json<PolicyOrder> {
    let (finalize, rewrite): (Vec<_>, Vec<_>) =
        (0..finalizes.len()).partition(|index| finalizes[*index]);
    Json(PolicyOrder {
        rewrite,
        prepare: (0..finalizes.len()).collect(),
        finalize,
    })
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Finalizer {
    original: Vec<ToolCall>,
    returned: Vec<ToolCall>,
    substitutions: Vec<Claim>,
    annotations: Vec<Claim>,
    proofs: Vec<Claim>,
}

#[derive(Deserialize)]
struct Claim {
    id: String,
    name: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum FinalizerVerdict {
    Authorized,
    VerifyProofs,
    Denied,
}

async fn policy_finalizer(Json(input): Json<Finalizer>) -> Json<FinalizerVerdict> {
    Json(evaluate_finalizer(input))
}

fn evaluate_finalizer(input: Finalizer) -> FinalizerVerdict {
    let given: HashMap<_, _> = input.original.iter().map(|call| (&call.id, call)).collect();
    let valid = |claim: &Claim| {
        given
            .get(&claim.id)
            .is_some_and(|call| call.name == claim.name)
    };
    let mut substitutions = HashSet::new();
    for claim in &input.substitutions {
        if !valid(claim) {
            return FinalizerVerdict::Denied;
        }
        substitutions.insert(&claim.id);
    }
    let mut verification_required = HashSet::new();
    for claim in input.annotations.iter().chain(&input.proofs) {
        if !valid(claim)
            || substitutions.contains(&claim.id)
            || !verification_required.insert(&claim.id)
        {
            return FinalizerVerdict::Denied;
        }
    }
    let mut seen = HashSet::new();
    for call in &input.returned {
        let Some(original) = given.get(&call.id).filter(|_| seen.insert(&call.id)) else {
            return FinalizerVerdict::Denied;
        };
        let same_tool = original.name == call.name && original.namespace == call.namespace;
        let substituted = substitutions.contains(&call.id);
        if original.review_details != call.review_details && (!substituted || same_tool) {
            return FinalizerVerdict::Denied;
        }
        if substituted {
            continue;
        }
        let modified = !same_tool || original.arguments != call.arguments;
        if modified && (!same_tool || !verification_required.remove(&call.id)) {
            return FinalizerVerdict::Denied;
        }
    }
    if !verification_required.is_empty() {
        return FinalizerVerdict::Denied;
    }
    if input.annotations.is_empty() && input.proofs.is_empty() {
        FinalizerVerdict::Authorized
    } else {
        FinalizerVerdict::VerifyProofs
    }
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolCall {
    id: String,
    name: String,
    arguments: String,
    namespace: Option<String>,
    wire_id: Option<String>,
    review_details: Option<String>,
}

#[derive(Deserialize)]
#[serde(tag = "decision", rename_all = "snake_case", deny_unknown_fields)]
enum Admission {
    Deny,
    Allow {
        original: Vec<ToolCall>,
        authorized: Vec<ToolCall>,
    },
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Release {
    Withhold,
    Replay,
    Replace,
}

async fn plan(Json(admission): Json<Admission>) -> Json<Release> {
    Json(release(admission))
}

fn release(admission: Admission) -> Release {
    match admission {
        Admission::Deny => Release::Withhold,
        Admission::Allow {
            original,
            authorized,
        } if original == authorized => Release::Replay,
        Admission::Allow { .. } => Release::Replace,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalizer_cannot_inject_a_call_or_rewrite_it_without_authorization() {
        let verdict = |returned: &str, substitutions: &str| {
            evaluate_finalizer(serde_json::from_str(&format!(r#"{{
                "original":[{{"id":"a","name":"note","arguments":"{{}}","reviewDetails":"reviewed"}}],
                "returned":{returned},"substitutions":{substitutions},"annotations":[],"proofs":[]
            }}"#)).unwrap())
        };
        let changed =
            r#"[{"id":"a","name":"note","arguments":"{\"x\":1}","reviewDetails":"reviewed"}]"#;
        assert_eq!(verdict(changed, "[]"), FinalizerVerdict::Denied);
        assert_eq!(
            verdict(changed, r#"[{"id":"a","name":"note"}]"#),
            FinalizerVerdict::Authorized
        );
        assert_eq!(
            verdict(r#"[{"id":"b","name":"note","arguments":"{}"}]"#, "[]"),
            FinalizerVerdict::Denied
        );
        assert_eq!(
            verdict(
                r#"[{"id":"a","name":"note","arguments":"{}","reviewDetails":"forged"}]"#,
                r#"[{"id":"a","name":"note"}]"#
            ),
            FinalizerVerdict::Denied
        );
    }

    #[test]
    fn raw_events_require_identical_ordered_authorization() {
        let decide = |original, authorized| {
            release(Admission::Allow {
                original,
                authorized,
            })
        };
        let call = |id: &str, wire_id: Option<&str>| ToolCall {
            id: id.into(),
            name: "note".into(),
            arguments: "{}".into(),
            namespace: None,
            wire_id: wire_id.map(str::to_owned),
            review_details: None,
        };
        assert_eq!(release(Admission::Deny), Release::Withhold);
        assert_eq!(
            decide(vec![call("a", None)], vec![call("a", None)]),
            Release::Replay
        );
        assert_eq!(decide(vec![call("a", None)], vec![]), Release::Replace);
        assert_eq!(
            decide(vec![call("a", None)], vec![call("a", Some("public-a"))]),
            Release::Replace
        );
        assert_eq!(
            decide(
                vec![call("a", None), call("b", None)],
                vec![call("b", None), call("a", None)]
            ),
            Release::Replace,
        );
    }
}
