### Trust

Trust describes how much OpenAPPA can rely on the data the agent has received. A trust rank is a named level, such as `suspicious` or `trusted`. Reading data at a lower rank lowers the trajectory's trust. Tools can require a minimum rank before they run.

Use these fields to declare trust restrictions and requirements:

| Field | Meaning | Example |
|---|---|---|
| `delta.trust` | Declares the result's trust rank. Reading it can lower the trajectory's trust. | `delta = { trust = "suspicious" }` |
| `requires.trust` | Sets the minimum trust rank needed to allow the call. | `requires = { trust = "trusted" }` |

Both fields must use a name from the policy's trust chain: the ordered list of ranks from least trusted to most trusted.

#### Trust ranks

If you omit `trust_chain`, the ranks are `suspicious` followed by `trusted`, from least trusted to most trusted.

To define your own ranks, set `trust_chain` in `[policy]`. For example, `trust_chain = ["untrusted", "reviewed", "trusted"]` defines three ranks in increasing order. This replaces the default ranks. A trust rank used elsewhere in the policy must appear in this list, or the policy does not load.

#### Choose a result's trust by who wrote it

Set a result's trust by who wrote its text, not by which service returns it or who can read it. Text that only members of the organization and its collaborators wrote keeps the trajectory's trust: its `delta` omits `trust`. Text that someone outside the organization wrote lowers it to `suspicious`: a web page, a comment by an outside contributor, a message in a shared channel with another company, a meeting transcript with outside participants. Trust and audience are independent: an issue on a public repository that only the team wrote keeps the trajectory's trust, and an outsider's comment on a private repository is `suspicious`.

A static contract does not see who wrote a particular result, so it assumes that anyone who can write there did: an issue on a public repository enters `suspicious`. An annotator can decide per call from the authors a [context provider](references/contracts/annotators.md#context-providers) reports. A member account an attacker controls is outside this model.

Guests and integrations a member installed write as the organization. An integration can relay text that an outsider wrote, such as a public issue title posted to a chat channel, and that text keeps the trajectory's trust.

#### Declare tool restrictions and requirements

In the example below, `trust_chain` explicitly sets the default ranks. The `read_web_page` contract marks its result as `suspicious`. Once the agent receives that result, OpenAPPA blocks `apply_db_migration` because it requires `trusted` data.

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

Reading a later result marked `trusted` does not undo the earlier drop to `suspicious`. A tool's `delta.trust` can lower the trajectory's trust, but cannot raise it. An [authority](references/contracts/sanitizers-authorities.md#authorities) with the required permission can approve a blocked call without changing the trajectory's trust.

### Effects

Effects record successful actions. List the tool's side effects in `effects` so later calls can check whether they occurred.

| Field | Meaning | Example |
|---|---|---|
| `effects` | Records the listed effects when the tool succeeds. | `effects = ["backup.completed"]` |
| `requires.effects.contains` | Requires the listed effects to have been recorded in the trajectory. | `contains = ["backup.completed"]` |
| `requires.effects.excludes` | Blocks the call if a listed effect is already recorded or declared by another call that has been allowed but has not finished. | `excludes = ["migration.applied"]` |

Only `contains` and `excludes` are allowed under `requires.effects`.

In the example below, `backup_database` records `backup.completed` when it succeeds. The migration requires that backup and cannot run if a migration has already succeeded or another migration call has been allowed but has not finished:

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

Attention requires fresh approval for each call. A previous approval or recorded effect cannot satisfy it.

| Field | Meaning | Example |
|---|---|---|
| `requires.attention` | Lists the approvals required before the tool can run. | `requires = { attention = ["sre-signoff"] }` |
| `permits.attention` | Lists the approvals an authority is allowed to give. `["*"]` alone allows every mark the policy declares except `blocked`. | `permits = { attention = ["sre-signoff"] }` |

In the example below, each `apply_db_migration` call requires `sre-signoff`. The `sre-reviewer` authority has permission to give that approval and uses the built-in human approval handler, `hitl`.

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

An attention mark is the name of an approval requirement, such as `sre-signoff`. OpenAPPA can ask any authority whose `permits.attention` includes that name, regardless of its tags. See [Authorities](references/contracts/sanitizers-authorities.md#authorities) for other approval permissions.

A deployment with one reviewer can permit every mark at once. `permits = { attention = ["*"] }` allows the authority to give every approval the policy declares, under any name a battery or annotator uses. The wildcard MUST be the only entry; `["*", "sre-signoff"]` is a load error.

`blocked` is the reserved mark that denies a call. No authority can list it in `permits.attention`, and `["*"]` does not cover it. A tool that requires `blocked` has no remedy, whatever authorities the policy declares.

