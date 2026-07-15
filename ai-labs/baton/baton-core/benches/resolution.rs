//! Benchmark: `evaluate` cost as the trajectory grows.
//!
//! The engine folds only a request's own argument and control dependencies,
//! so the turn-count axis exists precisely to show that evaluation cost does
//! not scale with trajectory length.

use std::collections::{BTreeMap, BTreeSet};

use baton_core::{
    ArgumentName, ArgumentSchema, ArgumentTree, AttentionRule, Audience, AudienceRule, Decision, Effects, KnownTrust,
    OpaqueValue, PolicyEngine, Requirements, Speaker, ToolContract, ToolName, ToolRequest, Trajectory, Trust, UserId,
    ValueId, ValueLabel,
};
use criterion::{BenchmarkId, Criterion, black_box, criterion_group, criterion_main};

const TOOL_COUNT: usize = 50;
const USER_COUNT: usize = 20;
const REQUEST_COUNT: usize = 1_024;
/// Values per request: arguments + control dependencies.
const DEPS_PER_REQUEST: usize = 4;
const TURN_COUNTS: [usize; 3] = [500, 5_000, 50_000];

struct World {
    engine: PolicyEngine,
    trajectory: Trajectory,
    requests: Vec<ToolRequest>,
}

impl World {
    fn new(turn_count: usize) -> Self {
        let mut rng = TinyRng::new(0x5eed_5eed_f00d ^ turn_count as u64);
        let users: Vec<UserId> = (0..USER_COUNT).map(user).collect();
        let tool_names: Vec<ToolName> = (0..TOOL_COUNT).map(tool).collect();

        let mut engine = PolicyEngine::new();
        for name in &tool_names {
            engine
                .register(random_contract(&mut rng, name.clone(), &users))
                .expect("benchmark tool names are unique");
        }

        let (trajectory, values) = random_trajectory(&mut rng, turn_count, &users, &tool_names);
        let requests = (0..REQUEST_COUNT)
            .map(|_| random_request(&mut rng, &tool_names, &values))
            .collect();

        Self {
            engine,
            trajectory,
            requests,
        }
    }
}

fn random_contract(rng: &mut TinyRng, name: ToolName, users: &[UserId]) -> ToolContract {
    ToolContract {
        name,
        requires: Some(Requirements {
            trust: random_trust_requirement(rng),
            audience: random_audience_requirement(rng),
            attention: random_attention_requirement(rng),
            forbid_prior_effects: BTreeSet::new(),
        }),
        output_label: random_label(rng, users),
        effects: Effects::none(),
        arguments: ArgumentSchema::opaque(),
    }
}

/// Build a trajectory of `turn_count` ingressed values and return the ids so
/// requests can reference them.
fn random_trajectory(
    rng: &mut TinyRng,
    turn_count: usize,
    users: &[UserId],
    tool_names: &[ToolName],
) -> (Trajectory, Vec<ValueId>) {
    let mut trajectory = Trajectory::new();
    let mut values = Vec::with_capacity(turn_count);
    for turn_index in 0..turn_count {
        let speaker = match rng.below(8) {
            0 => Speaker::confirming(random_user(rng, users), random_tool(rng, tool_names)),
            1..=4 => Speaker::user(random_user(rng, users)),
            _ => Speaker::Assistant,
        };
        values.push(trajectory.ingress(
            speaker,
            random_label(rng, users),
            OpaqueValue::new(format!("turn-{turn_index}")),
        ));
    }
    (trajectory, values)
}

fn random_request(rng: &mut TinyRng, tool_names: &[ToolName], values: &[ValueId]) -> ToolRequest {
    let mut fields = BTreeMap::new();
    for i in 0..DEPS_PER_REQUEST - 1 {
        fields.insert(
            ArgumentName::new(format!("arg-{i}")),
            ArgumentTree::Value(values[rng.below(values.len())]),
        );
    }
    ToolRequest::new(
        random_tool(rng, tool_names),
        ArgumentTree::Object(fields),
        BTreeSet::from([values[rng.below(values.len())]]),
    )
}

fn random_label(rng: &mut TinyRng, users: &[UserId]) -> ValueLabel {
    ValueLabel {
        audience: random_audience(rng, users),
        trust: random_trust(rng),
    }
}

fn random_audience(rng: &mut TinyRng, users: &[UserId]) -> Audience {
    match rng.below(6) {
        0 => Audience::PUBLIC,
        1 => Audience::UNKNOWN,
        _ => {
            let reader_count = 1 + rng.below(8);
            Audience::readers(random_user_set(rng, users, reader_count))
        }
    }
}

fn random_trust(rng: &mut TinyRng) -> Trust {
    match rng.below(4) {
        0 => Trust::UNKNOWN,
        1 => Trust::SUSPICIOUS,
        _ => Trust::TRUSTED,
    }
}

fn random_trust_requirement(rng: &mut TinyRng) -> Option<KnownTrust> {
    match rng.below(4) {
        0 => None,
        1 => Some(KnownTrust::Suspicious),
        _ => Some(KnownTrust::Trusted),
    }
}

fn random_audience_requirement(rng: &mut TinyRng) -> AudienceRule {
    match rng.below(2) {
        0 => AudienceRule::Unrestricted,
        _ => AudienceRule::FromRecipients,
    }
}

fn random_attention_requirement(rng: &mut TinyRng) -> AttentionRule {
    match rng.below(5) {
        0 => AttentionRule::ExplicitConfirmation,
        _ => AttentionRule::NotRequired,
    }
}

fn random_user_set(rng: &mut TinyRng, users: &[UserId], count: usize) -> BTreeSet<UserId> {
    (0..count).map(|_| random_user(rng, users)).collect()
}

fn random_user(rng: &mut TinyRng, users: &[UserId]) -> UserId {
    users[rng.below(users.len())].clone()
}

fn random_tool(rng: &mut TinyRng, tool_names: &[ToolName]) -> ToolName {
    tool_names[rng.below(tool_names.len())].clone()
}

fn user(index: usize) -> UserId {
    UserId::new(format!("user-{index:02}"))
}

fn tool(index: usize) -> ToolName {
    ToolName::new(format!("tool-{index:02}"))
}

#[derive(Clone, Copy)]
struct TinyRng(u64);

impl TinyRng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
        self.0
    }

    fn below(&mut self, upper: usize) -> usize {
        (self.next() as usize) % upper
    }
}

fn bench_resolution(c: &mut Criterion) {
    let mut group = c.benchmark_group("resolution");
    for turn_count in TURN_COUNTS {
        let mut world = World::new(turn_count);
        let mut request_index = 0;
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{turn_count}_turns")),
            &(),
            |b, ()| {
                b.iter(|| {
                    let request = world.requests[request_index % world.requests.len()].clone();
                    request_index = request_index.wrapping_add(1);
                    let decision = world
                        .engine
                        .evaluate(black_box(&mut world.trajectory), black_box(request));
                    match black_box(decision) {
                        Decision::Permitted(_) | Decision::Blocked { .. } => {}
                    }
                    // A permit stores the pending action; abandon it so the
                    // next iteration's distinct request is not refused.
                    world.trajectory.abandon_pending();
                });
            },
        );
    }
    group.finish();
}

criterion_group!(benches, bench_resolution);
criterion_main!(benches);
