## Restrictions and requirements

OpenAPPA tracks information flow using security labels composed of an audience set and a trust rank (`audience × trust`). Policies can also require recorded effects (`effects`) and per-call approvals (`attention`).

### Audiences

An audience defines the authorized recipients of data. Reading restricted data narrows the trajectory's audience label, restricting where the agent can send data in subsequent steps.

Use `delta.audience` to restrict the audience permitted to read a tool's output. Use `requires.audience` to enforce recipient preconditions on outbound calls:

| Field | Description | Runtime behavior |
|---|---|---|
| `delta.audience` | Allowed readers for the tool result. | Narrows the trajectory audience to the specified readers. |
| `forwards.audience` | Allowed readers for content the tool sends beyond its arguments. | Narrows the outbound label evaluated against `requires`. |
| `requires.audience.contains` | Required recipients for outbound data. | Verifies that the trajectory audience is authorized to reach every specified reader. |

In the example below, reading a CRM ticket restricts the trajectory to `internal`. The subsequent `publish_update` call requires unrestricted outbound reach (`public`):

```toml
[[policy.tool]]
name = "get_ticket_from_crm"
delta = { audience = ["internal"] }

[[policy.tool]]
name = "publish_update"
requires = { audience = { contains = ["public"] } }
```

Multiple entries combine readers as follows:

| Declaration | Meaning |
|---|---|
| `delta = { audience = ["@finance", "@support"] }` | Restricts output to readers who belong to either group (union of reader sets). |
| `requires = { audience = { contains = ["@finance", "@support"] } }` | Requires the current audience to contain all members of both groups. |

`contains` is the only supported precondition operator under `requires.audience`.

Audience entries support three formats:

| Format | Meaning |
|---|---|
| `"public"`, `"internal"`, `"self"` | Built-in audiences: unrestricted (`public`), organization members (`internal`), or the identity OpenAPPA acts for (`self`). |
| `"@name"`, `"@provider:selector"` | Configured groups (e.g. `"@finance"`) or source collections read directly from providers (e.g. `"@slack:user-group/oncall"`). |
| Literal reader IDs (e.g. `"alice@example.com"`) | Exact-match [reader IDs](#reader-ids). Note that `"finance"` represents a literal reader ID, whereas `"@finance"` references a configured group. |

For example, `audience = ["@finance", "alice@example.com"]` covers all members of the `finance` group plus the individual reader `alice@example.com`.

#### Built-in audiences

The built-in audience lattice forms a subset chain: `self` ⊆ `internal` ⊆ `public`. `internal` includes `self`, and `public` includes all recipients. Policies cannot add levels to this chain; define named groups for custom reader subsets.

Within a single audience array, specify at most one of `self` and `internal`. Do not combine `public` with other entries; `contains = ["public"]` requires completely unrestricted outbound reach.

#### Read an audience from a tool argument

Under `contains`, use `$<argument_name>` to read a destination audience dynamically from a tool argument (for example, `$recipient`):

```toml
[[policy.tool]]
name = "send_email"
requires = { audience = { contains = ["$recipient"] } }
```

OpenAPPA inspects the proposed call's `recipient` argument at check time and verifies that the trajectory's current audience contains those recipients. Referencing an argument placeholder makes that argument a required top-level string in the tool's `parameters` schema: OpenAPPA injects the property if omitted, enforces that it is required, and rejects schemas defining it as a non-string type. Argument placeholders as standalone audience entries are valid only within `contains`.

The argument value may be a literal reader ID, `public`, `self`, `internal`, or an `@` group mention. An unresolvable group mention causes an operational error and denies the call.

#### Read a source collection from a tool argument

A selector placeholder dynamically resolves an audience collection by extracting selector segments from tool arguments. Format placeholders as `@<provider>:<selector>` and substitute `$<argument_name>` for one or more segments:

```toml
# Reading a channel restricts the result to that channel's members.
[[policy.tool]]
name = "mcp/claude_ai_Slack/slack_read_channel"
delta = { audience = ["@slack:channel/$channel_id"] }

# Posting to a channel requires that its members can already read the data.
[[policy.tool]]
name = "mcp/claude_ai_Slack/slack_send_message"
requires = { trust = "trusted", audience = { contains = ["@slack:channel/$channel_id"] } }

# The service that reads Slack membership declares the channel template.
[externals.audience.slack]
url = "https://audience.corp/slack"
selectors = [{ template = "viewer", feeds = "self" }, { template = "channel/<id>" }]
```

A selector placeholder MUST be the sole entry in `delta.audience` or `requires.audience.contains`, or an entry in an annotator's `audiences` mandate (see [Permits and hint](references/contracts/annotators.md#permits-and-hint)). It MUST NOT appear alongside other entries in the same list or in an annotator response.

Each `$<argument_name>` becomes a required top-level argument in the tool schema. Unlike scalar placeholders under `contains`, selector placeholders also support string array arguments. The placeholder pattern MUST match a declared template under the provider's `selectors` definition (see [Declare selector templates](#declare-selector-templates)), with `$<argument_name>` mapping strictly to `<variable>` segments.

At evaluation time, OpenAPPA substitutes argument values into the selector, queries the external membership provider, pins the membership in the audit log, and applies the policy check. In the Slack example above, reading channel `C0123` restricts the output label to members of `C0123`, while posting to `C0123` requires that all channel members already belong to the trajectory's current audience.

When an argument is an array of strings, the placeholder represents the union of the referenced collections. For example, sharing with teams `["t1", "t2"]` under `contains = ["@corp:team/$team_ids"]` requires the current audience to contain every member of both teams; in `delta.audience`, it restricts output to readers in either team. A placeholder may include at most one array argument, capped at 100 elements. Empty arrays, arrays exceeding 100 elements, multiple array arguments, or invalid segment values cause immediate call rejection.

Static mentions must not contain segments beginning with `$`. The dollar-sign prefix is reserved strictly for argument placeholders and cannot be escaped.

#### Configure audience membership

External membership services resolve which individual reader IDs belong to an audience collection (such as members of a Google Workspace or Slack group).

Under `[policy.audience]`, `self` and `internal` specify the provider selectors supplying their members. `[policy.audience.group.<name>]` defines custom groups using `within` and `from`.

### Session principal

Multi-user hosts can specify the identity each session acts for by passing an email address as the session's principal during session startup. Within that session, `self` resolves directly to that email address without querying external `self` selectors, and `internal` automatically includes the principal alongside configured organization sources. Child trajectories and root forks inherit the session principal. Sessions initialized without a principal resolve `self` from `[policy.audience] self`.

Hosts supply the principal in-process via the embedded runtime API, or over HTTP via the `principal` field in `session_start`. Wire-supplied principals are supported under kagent when `APPA_SESSION_PRINCIPAL=wire` is set (the default, `none`, rejects requests containing a principal). Because `/hook` does not authenticate incoming callers, enable `wire` only when kagent authenticates requests and `/hook` is network-isolated. OpenAPPA relies on the host for authentication and does not verify session credentials directly; hosts must provide the verified address reported by membership providers. Multi-user configurations typically omit `[policy.audience] self`, causing any unauthenticated session lacking a principal to fail `self` checks. Policies referencing `self` in boundary declarations or starting labels still require a declared `self` source at load time.

Policies may omit `self` or `internal`. If a policy check requires members of an omitted audience level (for example, checking `contains = ["internal"]` after output restricted the audience to `self`), the check cannot resolve. OpenAPPA denies the call and names the missing key.

Each selector entry uses the format `provider:selector`. The provider name corresponds to a binding under `[externals.audience.<provider>]`. The selector identifies the specific group or resource to query, matching one of the provider's declared `selectors` templates.

The example below configures Google Workspace membership for `self`, `internal`, and `@finance`:

```toml
# Use the Google Workspace viewer as self and organization members as internal.
[policy.audience]
self = ["google-workspace:viewer"]
internal = ["google-workspace:full-members"]

# Define @finance from a Workspace group and declare it part of internal.
[policy.audience.group.finance]
within = "internal"
from = ["google-workspace:group/finance@corp.com"]

# Set the service that supplies Google Workspace membership and declare what it serves.
[externals.audience.google-workspace]
url = "https://audience.corp/google-workspace"
selectors = [
  { template = "viewer", feeds = "self" },
  { template = "full-members", feeds = "internal" },
  { template = "group/<group-address>" },
]
```

For `google-workspace:group/finance@corp.com`, OpenAPPA sends `group/finance@corp.com` as the selector query to `https://audience.corp/google-workspace`. The service returns the list of reader IDs belonging to that group.

Configuring a provider declares how OpenAPPA queries membership; the deployment must supply the underlying service endpoint or helper script. Pre-built batteries provide membership helpers for common providers (see What is a battery).

##### Declare selector templates

The `selectors` array on `[externals.audience.<provider>]` defines the selector templates supported by the membership service:

| Field | Description |
|---|---|
| `template` | Selector format consisting of literal segments and `<variable>` segments separated by `/` (e.g. `viewer`, `full-members`, `group/<group-address>`, or `channel/<id>`). |
| `feeds` | Built-in audience fed by this template (`self` or `internal`). Omit for templates supplying named groups and direct `@provider:selector` mentions. |

A provider is registered in a policy when referenced in `[policy.audience]`, a tool contract, an annotator mandate, or a selector placeholder. Every selector used in the policy MUST match a declared template for that provider with the required role:

| Audience key | Permitted template type |
|---|---|
| `self` | Templates with `feeds = "self"` (typically `viewer`, representing the session identity). |
| `internal` | Templates with `feeds = "internal"` (e.g. `full-members` or `org/<org>/members`). |
| `group.<name>.from`, direct mentions, and selector placeholders | Any declared template, excluding templates with `feeds = "self"`. |

OpenAPPA rejects configurations referencing selectors under incompatible keys (for example, using a `feeds = "self"` selector to populate `internal`). Load errors list all templates declared by the provider. Declared templates become part of the cryptographic policy identity; URLs, commands, and credentials do not.

When multiple sources are configured for an audience key, the resulting audience is their union. For example, `internal = ["google-workspace:full-members", "slack:full-members"]` combines members returned by both providers.

`within = "internal"` asserts that all members of the group belong to `internal`. OpenAPPA accepts this assertion without verifying individual member IDs against `internal` sources or checking email domains. Groups may declare `within = "self"` or `within = "internal"`.

Policies can reference provider groups directly as `"@slack:user-group/oncall"` without declaring an explicit `[policy.audience.group.<name>]` block, provided the `slack` provider is configured:

```toml
# Use Slack workspace members as internal.
[policy.audience]
internal = ["slack:full-members"]

# Restrict incident details to the Slack oncall group.
[[policy.tool]]
name = "get_incident"
delta = { audience = ["@slack:user-group/oncall"] }

# Set the service that supplies Slack membership and declare what it serves.
[externals.audience.slack]
url = "https://audience.corp/slack"
selectors = [
  { template = "viewer", feeds = "self" },
  { template = "full-members", feeds = "internal" },
  { template = "user-group/<handle>" },
]
```

OpenAPPA rejects references to undeclared named audiences, unconfigured providers, or selectors that match no declared template.

##### Reader IDs

A reader ID is an exact string identifier. Membership services assign reader IDs using verified email addresses when available, or qualified identifiers formatted as `<provider>:<id>` (such as `slack:U012345` or `github:alice`). The default Slack, GitHub, and Google Workspace integrations follow this convention. The GitHub service uses verified public profile emails when available, falling back to `github:<login>`.

Membership services must authenticate address ownership. When multiple services report the same verified email address, OpenAPPA recognizes them as the same reader. Qualified provider IDs remain distinct and do not alias across providers.

OpenAPPA lowercases the domain portion of email addresses while preserving the local part before `@` verbatim (including dots and `+tag` suffixes). It does not resolve email aliases or conflate personal and corporate addresses.

Every reader ID returned by a membership service must be a valid email address or match `<provider>:<non-empty>` under the responding provider. An ID containing a colon before the `@` symbol is parsed as a qualified ID, not an address. Any invalid format causes the membership response to be rejected as an operational failure, denying the call. If a service reports multiple addresses for one account, OpenAPPA treats them as distinct reader IDs, producing a strictly narrower audience.

##### Map members with `lookup` and `readers`

By default, a provider's own service resolves member lookups. Configure `lookup = "<name>"` on a provider to delegate member lookups to another `[externals.audience.<name>]` definition. The target entry must define exactly one of `readers`, `command`, or `url`. A `readers` entry provides a static inline map from `<provider>:<id>` to reader IDs, resolving lookups in-memory without network calls:

```toml
[policy.audience]
self = ["github:viewer"]
internal = ["github:org/acme/members"]

[externals.audience.github]
command = ["python3", "batteries/github/audience-source.py"]
token_env = "APPA_PROVIDER_GITHUB_TOKEN"
selectors = [
  { template = "viewer", feeds = "self" },
  { template = "org/<org>/members", feeds = "internal" },
  { template = "org/<org>/team/<team>" },
]
lookup = "people"

[externals.audience.people]
readers = { "github:alice" = "alice@corp.com" }
```

When `lookup` is configured, OpenAPPA automatically queries the lookup provider for any group member that is not already an email address. In the example above, `github:alice` returned for `org/acme/members` maps to `alice@corp.com`. If a lookup returns `null` or an ID is missing from `readers`, the identifier remains unchanged. Lookup results are pinned in the audit record alongside group membership responses.

Batteries bind their included membership services and selectors within their own `appa.toml`. Root policies retain `[policy.audience]` mappings. Redefining a provider binding in the root configuration when already declared by an included battery causes a duplicate binding error.

##### Source probe at start and reload

Before serving traffic from a new or reloaded policy, OpenAPPA executes a startup probe: it queries each referenced selector once, queries each configured `lookup` target with a sample member returned by those selectors, and validates that all returned values conform to reader ID rules. If a service fails, returns an invalid reader ID, or rejects declared selector templates, the startup or reload fails with an error specifying the provider and reason. If a policy reload fails its probe, OpenAPPA continues serving the existing configuration without interruption. Replay executions do not execute startup probes.

