//! Parity with the scikit-learn reference in fixtures/gen_fixtures.py (synthetic data).

use std::collections::BTreeMap;

use router_core::{LongShareModel, PlanInput, Policy, SizeModel, decide, plan};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    input: PlanInput,
    expected: Expected,
}

#[derive(Deserialize)]
struct Expected {
    size_intercept: f64,
    size_source_effects: BTreeMap<String, f64>,
    size_p_long: f64,
    size_p_normal: f64,
    size_p_smart: f64,
    long_share: LongShareModel,
    policy: Policy,
    expected_spend: f64,
    routes: Vec<ExpectedRoute>,
}

#[derive(Deserialize)]
struct ExpectedRoute {
    session: usize,
    tier_index: usize,
}

const COEF_RTOL: f64 = 1e-6;
const SPEND_RTOL: f64 = 1e-9;

fn assert_close(what: &str, actual: f64, expected: f64, rtol: f64) {
    assert!(
        (actual - expected).abs() <= rtol * expected.abs(),
        "{what}: {actual} vs {expected}"
    );
}

#[test]
fn matches_reference_fit_and_policy() {
    let fixture: Fixture =
        serde_json::from_str(include_str!("../fixtures/parity.json")).expect("fixture parses");
    let expected = fixture.expected;
    let history = fixture.input.history.clone();
    let plan = plan(fixture.input).expect("plan succeeds");

    let SizeModel::PoissonGlm {
        intercept,
        source_effects,
        p_long,
        p_normal,
        p_smart,
        ..
    } = &plan.size_model;
    assert_close("intercept", *intercept, expected.size_intercept, COEF_RTOL);
    assert_close("p_long", *p_long, expected.size_p_long, COEF_RTOL);
    assert_close("p_normal", *p_normal, expected.size_p_normal, COEF_RTOL);
    assert_close("p_smart", *p_smart, expected.size_p_smart, COEF_RTOL);
    assert_eq!(source_effects.len(), expected.size_source_effects.len());
    for effect in source_effects {
        let reference = expected.size_source_effects[&effect.source.0];
        assert_close(&effect.source.0, effect.coef, reference, COEF_RTOL);
    }

    let ls = plan.long_share;
    let reference = expected.long_share;
    assert_close("ls intercept", ls.intercept, reference.intercept, COEF_RTOL);
    assert_close("ls log_size", ls.log_size, reference.log_size, COEF_RTOL);

    assert_close(
        "lam_star",
        plan.policy.lam_star,
        expected.policy.lam_star,
        COEF_RTOL,
    );
    assert_close("q", plan.policy.q, expected.policy.q, COEF_RTOL);
    assert_close(
        "expected_spend",
        plan.summary.expected_spend,
        expected.expected_spend,
        SPEND_RTOL,
    );

    assert!(!expected.routes.is_empty());
    for route in &expected.routes {
        let decision =
            decide(&plan, &plan.policy, &history[route.session].features, 0.5).expect("decides");
        assert_eq!(
            decision.tier_index, route.tier_index,
            "session {}",
            route.session
        );
        assert_eq!(decision.propensity, 1.0);
    }
}
