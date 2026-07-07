//! A pinned, in-memory directory snapshot.
//!
//! Group membership is resolved against a *snapshot*, never against live state, so every decision is
//! reproducible: the [`DecisionRecord`](crate::engine::DecisionRecord) stores
//! [`DirectorySnapshot::hash`] and a replay against the same snapshot yields the same verdict.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::label::Subject;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DirectorySnapshot {
    user_teams: BTreeMap<String, BTreeSet<String>>,
    team_users: BTreeMap<String, BTreeSet<String>>,
    org_users: BTreeMap<String, BTreeSet<String>>,
}

impl DirectorySnapshot {
    pub fn builder() -> DirectoryBuilder {
        DirectoryBuilder::default()
    }

    /// Expand a set of subjects to the concrete users they denote. `Any` denotes the whole
    /// universe of known users. The result contains only [`Subject::User`].
    pub fn expand(&self, subjects: &BTreeSet<Subject>) -> BTreeSet<Subject> {
        let mut out = BTreeSet::new();
        for s in subjects {
            match s {
                Subject::User(u) => {
                    out.insert(Subject::User(u.clone()));
                }
                Subject::Team(t) => {
                    for u in self.team_users.get(t).into_iter().flatten() {
                        out.insert(Subject::User(u.clone()));
                    }
                }
                Subject::Org(o) => {
                    for u in self.org_users.get(o).into_iter().flatten() {
                        out.insert(Subject::User(u.clone()));
                    }
                }
                Subject::Any => {
                    for u in self.universe() {
                        out.insert(Subject::User(u));
                    }
                }
            }
        }
        out
    }

    /// Every user known to the directory.
    pub fn universe(&self) -> BTreeSet<String> {
        let mut users = BTreeSet::new();
        users.extend(self.user_teams.keys().cloned());
        for members in self.team_users.values().chain(self.org_users.values()) {
            users.extend(members.iter().cloned());
        }
        users
    }

    /// A stable content hash (FNV-1a over the canonical JSON encoding). Deterministic across runs so
    /// audit records are comparable — unlike `std`'s randomized `DefaultHasher`.
    pub fn hash(&self) -> String {
        let canonical = serde_json::to_string(self).expect("directory snapshot is serializable");
        fnv1a_hex(canonical.as_bytes())
    }
}

#[derive(Default)]
pub struct DirectoryBuilder {
    snapshot: DirectorySnapshot,
}

impl DirectoryBuilder {
    /// Record that `user` belongs to `team` (updates both directions of the map).
    pub fn user_in_team(mut self, user: &str, team: &str) -> Self {
        self.snapshot
            .user_teams
            .entry(user.to_string())
            .or_default()
            .insert(team.to_string());
        self.snapshot
            .team_users
            .entry(team.to_string())
            .or_default()
            .insert(user.to_string());
        self
    }

    pub fn user_in_org(mut self, user: &str, org: &str) -> Self {
        self.snapshot
            .org_users
            .entry(org.to_string())
            .or_default()
            .insert(user.to_string());
        self.snapshot
            .user_teams
            .entry(user.to_string())
            .or_default();
        self
    }

    pub fn build(self) -> DirectorySnapshot {
        self.snapshot
    }
}

fn fnv1a_hex(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}
