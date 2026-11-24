### Trust

Trust ranks quantify data provenance and integrity within a trajectory. A trust rank is a discrete level (such as `suspicious` or `trusted`). Reading data at a lower rank lowers the trajectory's trust, and later results cannot raise it again. Tools can require a minimum rank before they run.

Configure trust bounds using the following fields:

| Field | Description | Example |
|---|---|---|
| `delta.trust` | Output trust rank. Computes the meet with trajectory trust; can lower or maintain trust, but cannot elevate it. | `delta = { trust = "suspicious" }` |
| `forwards.trust` | Trust rank of content the tool sends beyond its arguments. Combined into the outbound label evaluated against `requires.trust`. | `forwards = { trust = "suspicious" }` |
| `requires.trust` | Minimum trajectory trust rank required to execute this tool call. | `requires = { trust = "trusted" }` |

Trust rank names must appear in the policy's configured trust chain.

#### Trust ranks

If omitted, `trust_chain` defaults to `["suspicious", "trusted"]` (ordered from least trusted to most trusted).

Define custom ranks by setting `trust_chain` under `[policy]`. For example, `trust_chain = ["untrusted", "reviewed", "trusted"]` defines three ranks in ascending order. Any trust rank referenced in contracts, annotators, or sanitizers must be declared in this list.

#### Choose a result's trust by who wrote it

Assign trust ranks based on author accountability rather than transport service or audience visibility. Trust reflects author accountability, not audience visibility: a public repository issue authored solely by your team maintains trust, whereas an external contributor's comment on an internal repository is `suspicious`.

Content authored strictly by organization members or verified collaborators maintains trajectory trust (by omitting `trust` from `delta`). Similarly, content from authenticated external publishers on controlled channels (such as vendor documentation or package registry metadata) can remain trusted. Surfaces open to arbitrary third-party writes (public issues, forum posts, package READMEs, web search results, or shared external channels) must assign `suspicious` trust.

Because static contracts cannot inspect per-call authors, they must assume worst-case write access: reading a public repository issue statically assigns `suspicious`. Dynamic annotators can evaluate specific authors using context reported by a [context provider](references/contracts/annotators.md#context-providers). Deployment hints (`[policy.deployment] hint`) instruct annotators on whether specific endpoints are trusted or suspicious.

Guest accounts and installed integrations write as the organization, so text they post keeps the trajectory's trust.

#### Declare tool restrictions and requirements

In the example below, `trust_chain` sets the default ranks explicitly. The `read_web_page` contract marks its output as `suspicious`. Once the trajectory ingests web content, OpenAPPA blocks `apply_db_migration` because it requires `trusted` inputs:

```toml
[policy]
version = 2
trust_chain = ["suspicious", "trusted"]

[[policy.tool]]
name = "read_web_page"
delta = { trust = "suspicious" }

[[policy.tool]]
name = "apply_db_migration"
requires = { trust = "trusted" }
```

Subsequent tool results marked `trusted` do not restore a trajectory's trust after a downgrade to `suspicious`. An [authority](references/contracts/sanitizers-authorities.md#authorities) with appropriate permissions can approve a blocked call without altering the underlying trajectory label, or a [sanitizer](references/contracts/sanitizers-authorities.md#sanitizers) can assign a cleaned result the audience or trust rank its `permits` allow.

### Effects

Effects track completed actions in trajectory history, so later calls can require that an action has, or has not, already occurred.

| Field | Description | Example |
|---|---|---|
| `effects` | Appends effect identifiers to trajectory history on call success. | `effects = ["backup.completed"]` |
| `requires.effects.contains` | Requires specified effect identifiers to be present in trajectory history. | `contains = ["backup.completed"]` |
| `requires.effects.excludes` | Denies the call if any specified effect is already recorded or emitted by an in-flight call. | `excludes = ["migration.applied"]` |

Only `contains` and `excludes` are permitted under `requires.effects`.

In the example below, `backup_database` records `backup.completed` upon success. The migration requires this prior backup and is blocked if a migration has already succeeded or if another migration call is currently in flight:

```toml
[[policy.tool]]
name = "backup_database"
delta = {}
effects = ["backup.completed"]

[[policy.tool]]
name = "apply_db_migration"
delta = {}
effects = ["migration.applied", "mutation"]

[policy.tool.requires.effects]
contains = ["backup.completed"]
excludes = ["migration.applied"]
```

### Attention

Attention marks require explicit, per-invocation approval. Prior approvals or recorded effects do not satisfy attention requirements.

| Field | Description | Example |
|---|---|---|
| `requires.attention` | Attention marks required to execute the tool call. | `requires = { attention = ["sre-signoff"] }` |
| `permits.attention` | Attention marks an authority is authorized to approve (`["*"]` covers all declared marks except `blocked`). | `permits = { attention = ["sre-signoff"] }` |

In the example below, `apply_db_migration` requires `sre-signoff`. The `sre-reviewer` authority uses the built-in human-in-the-loop reviewer (`hitl`) to approve this mark:

```toml
[[policy.tool]]
name = "apply_db_migration"
requires = { attention = ["sre-signoff"] }
delta = {}
effects = ["migration.applied"]

[[policy.authority]]
name = "sre-reviewer"
permits = { attention = ["sre-signoff"] }

[externals.authorities.sre-reviewer]
builtin = "hitl"
```

An attention mark is an identifier for an approval requirement (such as `sre-signoff`). OpenAPPA routes approval requests to any authority whose `permits.attention` includes that mark, irrespective of tool tags. See [Authorities](references/contracts/sanitizers-authorities.md#authorities).

Authorities with `permits = { attention = ["*"] }` can approve any declared attention mark (excluding `blocked`). The wildcard `"*"` must be the sole entry in `permits.attention`; combining it with named marks causes a configuration load error.

`blocked` is a reserved attention mark used for unconditional denials. No authority can permit `blocked`, and the `["*"]` wildcard does not match it. A call requiring `blocked` cannot be approved by any authority or remedy plan.

Use `blocked` to deny a call outright. Any other requirement that nothing in the policy can meet has the same effect on a new trajectory that inherits nothing: while a call selects that tool rule, it is never dispatched. `appa describe --check` reports each such requirement apart from whether the configuration loads, and exits unsuccessfully:

- an attention mark that no authority permits;
- an effect in `effects.contains` that no in-scope authority waives with `prior_effects_containing`, and that no other tool rule emits, counting only rules a call can select and release: a rule that an earlier rule for the same tool always matches first, because the earlier rule has no argument selector or each of its argument patterns covers every alternative of the later rule's pattern for that argument (the same alternative, `*`, or `prefix*` for an alternative that begins with `prefix`), a rule that requires `blocked`, and a tool served by the `jev` annotator emit nothing;
- a trust floor above the trust the call carries once its own `forwards` narrows the starting label, which no in-scope authority covers with `trust_below`.

Such a policy still loads, and the runtime refuses the call with no remedy plan. The check judges the policy revision it reads: a trajectory carried from an earlier revision, or a sanitizer that rewrites a call onto another tool rule, can still reach the call. The check reads only the requirements that the policy writes. It does not read the requirements that an annotator returns for a call.

