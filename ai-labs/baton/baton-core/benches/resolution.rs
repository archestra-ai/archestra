use std::collections::BTreeSet;

use baton_core::{
    AttentionRule, Audience, AudienceRule, Authority, AuthorityName, Decision, Effect, Effects, Grant, KnownTrust,
    Label, PolicyEngine, Requirements, Ruling, Speaker, ToolContract, ToolName, ToolRequest, Trajectory, Trust,
    UnknownPolicy, UserId, Violation,
};
use criterion::{BenchmarkId, Criterion, black_box, criterion_group, criterion_main};

const TOOL_COUNT: usize = 50;
const AUTHORITY_COUNT: usize = 10;
const USER_COUNT: usize = 20;
const REQUEST_COUNT: usize = 1_024;
const TURN_COUNTS: [usize; 3] = [500, 5_000, 50_000];

struct World {
    engine: PolicyEngine<AuthoritySet>,
    trajectory: Trajectory,
    requests: Vec<ToolRequest>,
}

impl World {
    fn new(turn_count: usize) -> Self {
        let mut rng = TinyRng::new(0x5eed_5eed_f00d ^ turn_count as u64);
        let users: Vec<UserId> = (0..USER_COUNT).map(user).collect();
        let tool_names: Vec<ToolName> = (0..TOOL_COUNT).map(tool).collect();

        let mut engine = PolicyEngine::new(authorities(&users), UnknownPolicy::Escalate);
        for name in &tool_names {
            engine
                .register(random_contract(&mut rng, name.clone(), &users))
                .expect("benchmark tool names are unique");
        }

        Self {
            engine,
            trajectory: random_trajectory(&mut rng, turn_count, &users, &tool_names),
            requests: (0..REQUEST_COUNT)
                .map(|_| random_request(&mut rng, &tool_names, &users))
                .collect(),
        }
    }
}

struct AuthoritySet {
    members: [BenchAuthority; AUTHORITY_COUNT],
}

impl Authority for AuthoritySet {
    fn rule(
        &self,
        needed: &Grant,
        request: &ToolRequest,
        context: &Label,
        violations: &[Violation],
    ) -> Option<(AuthorityName, Ruling)> {
        self.members
            .iter()
            .find_map(|member| member.rule(needed, request, context, violations))
    }
}

struct BenchAuthority {
    name: AuthorityName,
    mandate: Grant,
}

impl Authority for BenchAuthority {
    fn rule(&self, needed: &Grant, _: &ToolRequest, _: &Label, _: &[Violation]) -> Option<(AuthorityName, Ruling)> {
        self.mandate.covers(needed).then(|| {
            (
                self.name.clone(),
                Ruling::Approve {
                    reason: "benchmark approval".to_owned(),
                },
            )
        })
    }
}

fn authorities(users: &[UserId]) -> AuthoritySet {
    let user_set = |limit: usize| users.iter().take(limit).cloned().collect();
    AuthoritySet {
        members: [
            authority(0, Grant::empty()),
            authority(
                1,
                Grant {
                    trust: Some(KnownTrust::Suspicious),
                    ..Grant::empty()
                },
            ),
            authority(
                2,
                Grant {
                    trust: Some(KnownTrust::Trusted),
                    ..Grant::empty()
                },
            ),
            authority(
                3,
                Grant {
                    audience: Some(user_set(5)),
                    ..Grant::empty()
                },
            ),
            authority(
                4,
                Grant {
                    audience: Some(user_set(15)),
                    ..Grant::empty()
                },
            ),
            authority(
                5,
                Grant {
                    confirms: true,
                    ..Grant::empty()
                },
            ),
            authority(
                6,
                Grant {
                    effects: Some(BTreeSet::from([Effect::Mutation])),
                    ..Grant::empty()
                },
            ),
            authority(
                7,
                Grant {
                    effects: Some(BTreeSet::from([Effect::Egress])),
                    ..Grant::empty()
                },
            ),
            authority(
                8,
                Grant {
                    trust: Some(KnownTrust::Trusted),
                    audience: Some(user_set(USER_COUNT)),
                    ..Grant::empty()
                },
            ),
            authority(
                9,
                Grant {
                    trust: Some(KnownTrust::Trusted),
                    audience: Some(user_set(USER_COUNT)),
                    effects: Some(BTreeSet::from([Effect::Mutation, Effect::Egress])),
                    confirms: true,
                },
            ),
        ],
    }
}

fn authority(index: usize, mandate: Grant) -> BenchAuthority {
    BenchAuthority {
        name: AuthorityName::new(format!("bench-authority-{index}")),
        mandate,
    }
}

fn random_contract(rng: &mut TinyRng, name: ToolName, users: &[UserId]) -> ToolContract {
    ToolContract {
        name,
        requires: Requirements {
            trust: random_trust_requirement(rng),
            audience: random_audience_requirement(rng),
            attention: random_attention_requirement(rng),
            forbid_prior_effects: random_forbidden_effects(rng),
        },
        output_label: random_label(rng, users),
    }
}

fn random_trajectory(rng: &mut TinyRng, turn_count: usize, users: &[UserId], tool_names: &[ToolName]) -> Trajectory {
    let mut trajectory = Trajectory::new();
    for turn_index in 0..turn_count {
        let speaker = match rng.below(8) {
            0 => Speaker::confirming(random_user(rng, users), random_tool(rng, tool_names)),
            1..=4 => Speaker::user(random_user(rng, users)),
            _ => Speaker::Assistant,
        };
        trajectory.push_message(random_label(rng, users), speaker, format!("turn-{turn_index}"));
    }
    trajectory
}

fn random_request(rng: &mut TinyRng, tool_names: &[ToolName], users: &[UserId]) -> ToolRequest {
    let recipient_count = 1 + rng.below(4);
    let recipients: Vec<UserId> = (0..recipient_count).map(|_| random_user(rng, users)).collect();
    ToolRequest::exposing(random_tool(rng, tool_names), recipients)
}

fn random_label(rng: &mut TinyRng, users: &[UserId]) -> Label {
    Label {
        audience: random_audience(rng, users),
        trust: random_trust(rng),
        effects: random_effects(rng),
        audit: Vec::new(),
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

fn random_effects(rng: &mut TinyRng) -> Effects {
    match rng.below(5) {
        0 => Effects::UNKNOWN,
        1 => Effects::declared([Effect::Mutation]),
        2 => Effects::declared([Effect::Egress]),
        3 => Effects::declared([Effect::Mutation, Effect::Egress]),
        _ => Effects::none(),
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
        _ => AudienceRule::RecipientsWithinContext,
    }
}

fn random_attention_requirement(rng: &mut TinyRng) -> AttentionRule {
    match rng.below(5) {
        0 => AttentionRule::ExplicitConfirmation,
        _ => AttentionRule::NotRequired,
    }
}

fn random_forbidden_effects(rng: &mut TinyRng) -> BTreeSet<Effect> {
    match rng.below(4) {
        0 => BTreeSet::from([Effect::Mutation]),
        1 => BTreeSet::from([Effect::Egress]),
        2 => BTreeSet::from([Effect::Mutation, Effect::Egress]),
        _ => BTreeSet::new(),
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
        let world = World::new(turn_count);
        let mut request_index = 0;
        group.bench_with_input(
            BenchmarkId::from_parameter(format!("{turn_count}_turns")),
            &world,
            |b, world| {
                b.iter(|| {
                    let request = &world.requests[request_index % world.requests.len()];
                    request_index = request_index.wrapping_add(1);
                    let decision = world.engine.evaluate(black_box(&world.trajectory), black_box(request));
                    match black_box(decision) {
                        Decision::Permitted(_) | Decision::Blocked { .. } => {}
                    }
                });
            },
        );
    }
    group.finish();
}

criterion_group!(benches, bench_resolution);
criterion_main!(benches);
