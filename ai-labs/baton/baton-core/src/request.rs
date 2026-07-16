//! Executable requests: the argument tree the engine checks *and* the adapter
//! executes, plus the flow-label folds.
//!
//! The request contains the actual argument tree that will be rendered for
//! the tool — recipients, paths, commands, URLs are all values in this tree.
//! There is no second, unbound argument object for the harness to substitute
//! later: the canonical rendering handed out at release time is produced from
//! the exact tree the engine checked.
//!
//! Control dependence rides along as a mandatory set of value ids: the values
//! read by whatever *selected* this invocation, tool, argument structure, and
//! recipients. It is deliberately a dependency set, not a caller-supplied
//! label — a public control label would be a relabeling hole. The engine
//! folds the labels itself:
//!
//! ```text
//! L_args    = fold(labels of all values rendered into the request)
//! L_control = fold(labels of the control dependencies)
//! L_flow    = combine(L_args, L_control)
//! ```

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::Serialize;

use crate::ToolName;
use crate::dimension::{Effects, UserId};
use crate::revision::{ActionId, FlowId, Revision, ValueId};
use crate::value::{UnknownValue, ValueStore};

/// Name of one argument in an [`ArgumentTree::Object`].
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct ArgumentName(String);

impl ArgumentName {
    pub fn new(name: impl Into<String>) -> Self {
        Self(name.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ArgumentName {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl From<&str> for ArgumentName {
    fn from(name: &str) -> Self {
        Self::new(name)
    }
}

impl From<String> for ArgumentName {
    fn from(name: String) -> Self {
        Self::new(name)
    }
}

/// The executable argument structure: every leaf is a stored value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ArgumentTree<T> {
    Value(T),
    List(Vec<ArgumentTree<T>>),
    Object(BTreeMap<ArgumentName, ArgumentTree<T>>),
}

impl<T> From<T> for ArgumentTree<T> {
    fn from(leaf: T) -> Self {
        Self::Value(leaf)
    }
}

impl<T> ArgumentTree<T> {
    /// The empty argument object — a no-argument invocation.
    pub fn empty() -> Self {
        Self::Object(BTreeMap::new())
    }

    /// An object node from `(name, subtree)` pairs. Leaves coerce, so
    /// `ArgumentTree::object([("to", to), ("body", report)])` reads plainly.
    pub fn object<N, V>(fields: impl IntoIterator<Item = (N, V)>) -> Self
    where
        N: Into<ArgumentName>,
        V: Into<Self>,
    {
        Self::Object(
            fields
                .into_iter()
                .map(|(name, value)| (name.into(), value.into()))
                .collect(),
        )
    }
}

impl<T: Copy + Ord> ArgumentTree<T> {
    /// Every leaf value in the tree.
    pub fn leaves(&self) -> BTreeSet<T> {
        let mut out = BTreeSet::new();
        self.collect_leaves(&mut out);
        out
    }

    fn collect_leaves(&self, out: &mut BTreeSet<T>) {
        match self {
            Self::Value(v) => {
                out.insert(*v);
            }
            Self::List(items) => {
                for item in items {
                    item.collect_leaves(out);
                }
            }
            Self::Object(fields) => {
                for field in fields.values() {
                    field.collect_leaves(out);
                }
            }
        }
    }

    /// The subtree under a top-level object key, if the root is an object and
    /// the key is present.
    pub fn top_level(&self, name: &ArgumentName) -> Option<&Self> {
        match self {
            Self::Object(fields) => fields.get(name),
            Self::Value(_) | Self::List(_) => None,
        }
    }

    /// Replace every leaf equal to `from` with `to` — how a transformed
    /// value takes its source's argument slot. Unchanged leaves keep their
    /// identity.
    pub(crate) fn substitute(&mut self, from: T, to: T)
    where
        T: PartialEq,
    {
        match self {
            Self::Value(v) => {
                if *v == from {
                    *v = to;
                }
            }
            Self::List(items) => {
                for item in items {
                    item.substitute(from, to);
                }
            }
            Self::Object(fields) => {
                for field in fields.values_mut() {
                    field.substitute(from, to);
                }
            }
        }
    }
}

/// Where a contract finds typed meaning in an argument tree. The engine never
/// interprets opaque bytes except where a role requires it.
///
/// The only role the PoC needs is `recipients`: the top-level key whose
/// leaves are read as [`UserId`]s for the audience check. Everything else is
/// opaque payload.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ArgumentSchema {
    pub recipients: Option<ArgumentName>,
}

impl ArgumentSchema {
    /// No typed roles: every argument is opaque payload.
    pub fn opaque() -> Self {
        Self::default()
    }

    /// The top-level key `name` holds the recipients this call exposes
    /// context to.
    pub fn with_recipients(name: ArgumentName) -> Self {
        Self { recipients: Some(name) }
    }

    /// Resolve the recipient set from a request's argument tree: the leaves
    /// under the recipients role, each read as a [`UserId`] from its stored
    /// bytes. Empty when the role is absent from the schema or the tree —
    /// an audience-guarded sink then breaches as `UndeclaredRecipients`.
    pub fn resolve_recipients(
        &self,
        arguments: &ArgumentTree<ValueId>,
        store: &ValueStore,
    ) -> Result<BTreeSet<UserId>, UnknownValue> {
        let Some(role) = &self.recipients else {
            return Ok(BTreeSet::new());
        };
        let Some(subtree) = arguments.top_level(role) else {
            return Ok(BTreeSet::new());
        };
        subtree
            .leaves()
            .into_iter()
            .map(|id| Ok(UserId::new(store.body(id)?.as_str())))
            .collect()
    }
}

/// A concrete tool invocation the policy is asked to authorize: the exact
/// executable argument tree plus the control dependencies of whatever
/// selected it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ToolRequest {
    pub tool: ToolName,
    pub arguments: ArgumentTree<ValueId>,
    /// Values read by the component that selected this invocation, tool,
    /// argument structure, and recipients. Mandatory: completeness is the
    /// harness's mediation obligation.
    pub control: BTreeSet<ValueId>,
}

impl ToolRequest {
    pub fn new(tool: ToolName, arguments: ArgumentTree<ValueId>, control: impl IntoIterator<Item = ValueId>) -> Self {
        Self {
            tool,
            arguments,
            control: control.into_iter().collect(),
        }
    }
}

/// An assistant emission proposal, mediated like any other sink: a request
/// referencing immutable values, checked through the same pipeline as a tool
/// dispatch. The harness emits only bytes rendered from the exact checked
/// tree. Core never infers that a turn is "final" — the caller proposes an
/// emission whenever assistant output is about to cross the mediation
/// boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct EmissionRequest {
    pub body: ArgumentTree<ValueId>,
    pub control: BTreeSet<ValueId>,
    /// The trajectory revision this emission was composed against. A fresh
    /// proposal composed against a revision the trajectory moved past is
    /// refused; once pending, re-entry identity is the request content.
    pub basis: Revision,
}

/// The stored pending emission: the (at most one) emission proposal whose
/// check came back remediable. Like a pending action it retains BOTH the
/// immutable original (the identity basis for idempotent re-entry) and the
/// current form (what actually gets checked and emitted — a `DeriveValue`
/// remedy substitutes into it). Independent of the pending tool-action slot.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PendingEmission {
    /// The checked flow this emission is the target of: plans, check-scoped
    /// grants, and check facts bind to it.
    flow: FlowId,
    original: EmissionRequest,
    current: EmissionRequest,
}

impl PendingEmission {
    pub(crate) fn proposed(flow: FlowId, request: EmissionRequest) -> Self {
        Self {
            flow,
            original: request.clone(),
            current: request,
        }
    }

    /// The checked flow this emission is the target of.
    pub fn flow(&self) -> FlowId {
        self.flow
    }

    pub fn original(&self) -> &EmissionRequest {
        &self.original
    }

    pub fn current(&self) -> &EmissionRequest {
        &self.current
    }

    /// A content-justified `Derive` step replaced `from` with the derived
    /// `to` in the current body tree. The original proposal is untouched.
    pub(crate) fn substitute_body(&mut self, from: ValueId, to: ValueId) {
        self.current.body.substitute(from, to);
    }
}

/// Lifecycle of the (at most one) pending action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum ActionState {
    Proposed,
    Constrained,
    Released,
}

/// The stored pending action. It retains BOTH the immutable original
/// proposal (the identity basis for idempotent re-entry) and the current,
/// possibly constrained form (what actually gets checked and dispatched) —
/// `ActionId` alone cannot distinguish re-entry of the original from an
/// independent proposal that merely equals the constrained form.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct PendingAction {
    id: ActionId,
    /// The checked flow this action is the target of: plans, check-scoped
    /// grants, and check facts bind to it; re-entry re-checks the same flow.
    flow: FlowId,
    original: ToolRequest,
    current: ToolRequest,
    proposed_effects: Effects,
    /// Surface growth an `Accept` authority acquired for this action (criterion
    /// (1)). Suppresses the surface-growth soft-ban on the recheck; the effect
    /// still commits at release. Grows monotonically like the past it feeds.
    accepted_effects: Effects,
    state: ActionState,
}

impl PendingAction {
    pub(crate) fn proposed(id: ActionId, flow: FlowId, request: ToolRequest, proposed_effects: Effects) -> Self {
        Self {
            id,
            flow,
            original: request.clone(),
            current: request,
            proposed_effects,
            accepted_effects: Effects::none(),
            state: ActionState::Proposed,
        }
    }

    pub fn id(&self) -> ActionId {
        self.id
    }

    /// The checked flow this action is the target of.
    pub fn flow(&self) -> FlowId {
        self.flow
    }

    pub fn original(&self) -> &ToolRequest {
        &self.original
    }

    pub fn current(&self) -> &ToolRequest {
        &self.current
    }

    pub fn proposed_effects(&self) -> &Effects {
        &self.proposed_effects
    }

    /// The surface growth acquired for this action so far.
    pub fn accepted_effects(&self) -> &Effects {
        &self.accepted_effects
    }

    pub fn state(&self) -> ActionState {
        self.state
    }

    pub(crate) fn mark_released(&mut self) {
        self.state = ActionState::Released;
    }

    /// A content-justified `Derive` step replaced `from` with the derived `to` in the
    /// current argument tree. The original proposal is untouched — it is the
    /// identity basis, never dispatched.
    pub(crate) fn substitute_argument(&mut self, from: ValueId, to: ValueId) {
        self.current.arguments.substitute(from, to);
    }

    /// A `ConstrainAction` step narrowed this action through a registered
    /// tool-identity mapping.
    pub(crate) fn constrain(&mut self, to_tool: ToolName, effects: Effects) {
        self.current.tool = to_tool;
        self.proposed_effects = effects;
        self.state = ActionState::Constrained;
    }

    /// An `AcceptGrowth` step acquired `effects` for this action. Monotone: an
    /// acceptance only adds to the acquired surface.
    pub(crate) fn accept_growth(&mut self, effects: Effects) {
        self.accepted_effects = self.accepted_effects.clone().combine(effects);
    }
}

/// Deterministic canonical rendering of an argument tree: leaves inline their
/// stored bytes as JSON strings, lists and objects render in structural
/// (`BTreeMap`) order. The engine renders once at release time and hands the
/// adapter the owned result — adapters never re-render.
pub(crate) fn render(tree: &ArgumentTree<ValueId>, store: &ValueStore) -> Result<String, UnknownValue> {
    let mut out = String::new();
    render_into(tree, store, &mut out)?;
    Ok(out)
}

fn render_into(tree: &ArgumentTree<ValueId>, store: &ValueStore, out: &mut String) -> Result<(), UnknownValue> {
    match tree {
        ArgumentTree::Value(id) => {
            render_string(store.body(*id)?.as_str(), out);
        }
        ArgumentTree::List(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render_into(item, store, out)?;
            }
            out.push(']');
        }
        ArgumentTree::Object(fields) => {
            out.push('{');
            for (i, (name, field)) in fields.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                render_string(name.as_str(), out);
                out.push(':');
                render_into(field, store, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn render_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::value::OpaqueValue;

    fn store_with(bodies: &[&str]) -> (ValueStore, Vec<ValueId>) {
        let mut store = ValueStore::default();
        let ids = bodies.iter().map(|body| store.admit(OpaqueValue::new(*body))).collect();
        (store, ids)
    }

    #[test]
    fn leaves_collects_every_nested_value() {
        let (_, ids) = store_with(&["a", "b", "c"]);
        let tree = ArgumentTree::Object(BTreeMap::from([
            (ArgumentName::new("x"), ArgumentTree::Value(ids[0])),
            (
                ArgumentName::new("y"),
                ArgumentTree::List(vec![ArgumentTree::Value(ids[1]), ArgumentTree::Value(ids[2])]),
            ),
        ]));
        assert_eq!(tree.leaves(), BTreeSet::from([ids[0], ids[1], ids[2]]));
    }

    #[test]
    fn recipients_resolve_from_stored_bytes() {
        let (store, ids) = store_with(&["bob", "charlie", "body text"]);
        let tree = ArgumentTree::Object(BTreeMap::from([
            (
                ArgumentName::new("to"),
                ArgumentTree::List(vec![ArgumentTree::Value(ids[0]), ArgumentTree::Value(ids[1])]),
            ),
            (ArgumentName::new("body"), ArgumentTree::Value(ids[2])),
        ]));
        let schema = ArgumentSchema::with_recipients(ArgumentName::new("to"));
        assert_eq!(
            schema.resolve_recipients(&tree, &store).unwrap(),
            BTreeSet::from([UserId::new("bob"), UserId::new("charlie")])
        );
    }

    #[test]
    fn missing_recipients_role_resolves_empty() {
        let (store, ids) = store_with(&["body"]);
        let tree = ArgumentTree::Object(BTreeMap::from([(
            ArgumentName::new("body"),
            ArgumentTree::Value(ids[0]),
        )]));
        let schema = ArgumentSchema::with_recipients(ArgumentName::new("to"));
        assert_eq!(schema.resolve_recipients(&tree, &store).unwrap(), BTreeSet::new());
    }

    #[test]
    fn substitution_touches_only_the_current_body() {
        let (_, ids) = store_with(&["raw", "clean"]);
        let mut pending = PendingEmission::proposed(
            FlowId::new(0),
            EmissionRequest {
                body: ArgumentTree::Value(ids[0]),
                control: BTreeSet::new(),
                basis: crate::revision::Revision::INITIAL,
            },
        );
        pending.substitute_body(ids[0], ids[1]);
        assert_eq!(pending.current().body, ArgumentTree::Value(ids[1]));
        assert_eq!(pending.original().body, ArgumentTree::Value(ids[0]));
    }

    #[test]
    fn rendering_is_deterministic_and_escaped() {
        let (store, ids) = store_with(&["he said \"hi\"\n", "b"]);
        let tree = ArgumentTree::Object(BTreeMap::from([
            (ArgumentName::new("msg"), ArgumentTree::Value(ids[0])),
            (ArgumentName::new("aux"), ArgumentTree::Value(ids[1])),
        ]));
        assert_eq!(
            render(&tree, &store).unwrap(),
            r#"{"aux":"b","msg":"he said \"hi\"\n"}"#
        );
    }
}
