## Restrictions and requirements

Audience and trust form the security label. Effects record completed actions. Attention requires approval for a specific call. The examples below show how to declare each one.

### Audiences

An audience identifies who can receive data. Reading restricted data limits where the trajectory can send data later.

Use `delta.audience` to restrict who can receive a tool's result. Use `requires.audience` to check the current audience before a tool call:

| Field | What OpenAPPA does |
|---|---|
| `delta.audience` | Restricts the result to the specified readers. |
| `requires.audience.contains` | Checks that the current audience includes all specified readers. |
| `requires.audience.within` | Checks that every reader in the current audience belongs to the specified audience. |

In the example below, reading a ticket restricts the trajectory to `internal`. The `publish_update` call requires unrestricted sharing. The `process_internal_data` call requires the trajectory's audience to be within `internal`.

```toml
[[policy.tool]]
name = "get_ticket_from_crm"
delta = { audience = ["internal"] }

[[policy.tool]]
name = "publish_update"
requires = { audience = { contains = ["public"] } }

[[policy.tool]]
name = "process_internal_data"
requires = { audience = { within = ["internal"] } }
```

Multiple entries combine readers from all entries. For example:

| Declaration | Meaning |
|---|---|
| `delta = { audience = ["@finance", "@support"] }` | The result is for readers who belong to either group. |
| `requires = { audience = { contains = ["@finance", "@support"] } }` | The current audience must include every member of both groups. |
| `requires = { audience = { within = ["@finance", "@support"] } }` | Every current reader must belong to at least one of the two groups. |

`within` checks the trajectory's audience, not the recipient of one call. Only `contains` and `within` are allowed under `requires.audience`. Other keys cause a load error.

Each audience entry can be one of the following:

| Entry | Meaning |
|---|---|
| `"public"`, `"internal"`, `"self"` | Built-in audiences: everyone (`public`), the organization (`internal`), or the identity OpenAPPA acts for (`self`). |
| `"@name"`, `"@provider:selector"` | A configured group, such as `"@finance"`, or a group read directly from a source, such as `"@slack:user-group/oncall"`. |
| Other strings, such as `"alice@example.com"` | A literal [reader ID](#reader-ids), compared exactly. For example, `"finance"` is a reader ID; `"@finance"` refers to a group. |

For example, `audience = ["@finance", "alice@example.com"]` includes all members of `finance` and the individual reader `alice@example.com`.

#### Built-in audiences

The built-in chain is `self` ⊆ `internal` ⊆ `public`: `internal` includes `self`, and `public` includes everyone. Policies cannot add levels to this chain. Use named audiences for other groups of readers.

Within one set of square brackets, use at most one of `self` and `internal`. Do not combine `public` with other entries. `contains = ["public"]` requires unrestricted sharing, as shown by `publish_update` above.

#### Read an audience from a tool argument

Under `contains`, use `$<argument_name>` to read an audience from a tool argument. The name is the tool's argument name; `recipient` below is one example:

```toml
[[policy.tool]]
name = "send_email"
requires = { audience = { contains = ["$recipient"] } }
```

OpenAPPA reads the proposed call's `recipient` argument and checks that the current audience includes its readers. The binding makes `recipient` a required top-level string of the tool's `parameters`: OpenAPPA adds the property when the schema omits it, makes a declared string property required, and rejects a schema that declares it with another type. A whole-entry argument placeholder is allowed only under `contains`.

The argument can contain a literal reader, `public`, `self`, `internal`, or an `@` mention. An unresolved dynamic mention stops the call with an operational error.

#### Read a source collection from a tool argument

A selector placeholder names a source collection whose selector takes one or more segments from the call. Write `@<provider>:<selector>` and put `$<argument_name>` in place of a segment:

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

A selector placeholder MAY be the only entry of `delta.audience` or of `requires.audience.contains`. It MAY also be an entry of an annotator's `audiences` mandate; see [Permits and hint](references/contracts/annotators.md#permits-and-hint). It MUST NOT appear under `within`, beside other entries in one list, or in an annotator's answer.

Each `$<argument_name>` becomes a required top-level argument of the tool, as under `contains`, except that a selector placeholder also accepts an argument declared as an array of strings; see [Read an audience from a tool argument](#read-an-audience-from-a-tool-argument). The spelling, with each `$<argument_name>` read as a variable segment, MUST match one template the provider declares under `selectors`; see [Declare selector templates](#declare-selector-templates). A `$<argument_name>` segment matches only a `<variable>` segment of the template.

At check time OpenAPPA replaces each `$<argument_name>` with the call's argument value. The result is an ordinary `@provider:selector` mention: OpenAPPA reads its members from the provider's service, records the answer with the decision, and checks the call exactly as for a static mention. In the example above, reading channel `C0123` restricts the result to the members of `C0123`, and posting to `C0123` requires that every member of `C0123` is already a reader.

An array argument names one collection per element, and the placeholder stands for their union. Sharing a resource with teams `["t1", "t2"]` under `contains = ["@corp:team/$team_ids"]` requires that every member of `t1` and every member of `t2` is already a reader; under `delta.audience` it restricts the result to readers who belong to either team. At most one argument of a placeholder may be an array, and it may hold at most 100 elements, since each collection is a membership read. An empty array, a longer one, a second array, or an element that is not one selector segment fills no placeholder, and OpenAPPA refuses the call.

Static mentions cannot contain segments starting with `$`. Dollar-sign prefixes are reserved for argument placeholders and cannot be escaped.

#### Configure audience membership

Membership answers: who belongs to this audience? OpenAPPA asks an external membership service for the members. For example, that service can read the members of a Slack group.

Under `[policy.audience]`, `self` and `internal` list the selectors that supply their members. `[policy.audience.group.<name>]` declares a named group with `within` and `from`.

### Session principal

A host that serves many people can name the person each session acts for. It passes that person's email address as the session's principal when the session starts. In that session, `self` is exactly that address. OpenAPPA does not ask the `self` selectors, and `internal` includes the principal beside its own sources. Children and root forks of the session act for the same principal. A session without a principal uses `[policy.audience] self` as usual.

A host names the principal in process, through the embedded runtime API; the HTTP hook wire does not carry one. OpenAPPA takes the principal on the host's word; it does not authenticate it. Only a host that authenticated the person should name one, and the principal must be the address the membership services report for that person. A multi-user host usually leaves `[policy.audience] self` empty, so a session that names no principal cannot establish `self` and is denied as described below. A policy that names `self` in its boundary or starting label still needs a `self` source to load, because it is checked before any session names a principal.

A policy can omit `self` or `internal`. A check that needs the members of an omitted level — for example, `contains = ["internal"]` after a `delta` narrowed the audience to `self` — cannot be established. OpenAPPA denies that call and names the missing key; proposing the call again does not change the answer.

Each selector entry has the form `provider:selector`. The provider identifies the service configured under `[externals.audience.<provider>]`. The selector tells that service which reader or group to read. The service's `selectors` declaration lists the selector templates it understands.

The example below uses a Google Workspace membership service to define `self`, `internal`, and `@finance`:

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

For `google-workspace:group/finance@corp.com`, OpenAPPA sends `group/finance@corp.com` as the selector to the membership service configured under `[externals.audience.google-workspace]`. The service reads the group's members and returns them to OpenAPPA.

Configuring a provider does not connect OpenAPPA directly to Google Workspace, Slack, or GitHub; you must supply the service that makes that connection. Each shipped battery supplies the service for the provider it covers and declares that service's templates; see What is a battery.

##### Declare selector templates

`selectors` on `[externals.audience.<provider>]` declares the selector templates the service understands. Each entry has a `template` and an optional `feeds`:

| Field | Meaning |
|---|---|
| `template` | One selector format: literal segments and `<variable>` segments separated by `/`, such as `viewer`, `full-members`, `group/<group-address>`, or `channel/<id>`. A `<variable>` segment matches one non-empty segment. |
| `feeds` | `self` or `internal`: the built-in audience this template may supply. Omit it for a template that supplies only named groups and `@provider:selector` mentions. |

A provider exists in a policy when the policy names it: by a `[policy.audience]` selector, by a `@provider:selector` mention in a tool contract or an annotator mandate, or by a selector placeholder. Every selector the policy writes MUST match one declared template of its provider, with the role its position needs:

| Audience key | Templates you can use |
|---|---|
| `self` | A template with `feeds = "self"`, usually `viewer`: the identity OpenAPPA acts for. |
| `internal` | A template with `feeds = "internal"`, such as `full-members` or `org/<org>/members`. For example, `github:org/acme/members` makes members of `acme` internal. Members of other GitHub organizations are not included by this source. |
| `group.<name>.from`, `@provider:selector` mentions, and selector placeholders | Any declared template except one with `feeds = "self"`. |

OpenAPPA rejects the configuration if you use a selector in the wrong key. For example, `slack:viewer` cannot define `internal`. The load error for a selector that matches no template lists the templates the provider declares. The declared templates enter the policy identity; the URL, command, and credentials do not.

If a key lists several sources, the audience includes members from any of them. For example, `internal = ["google-workspace:full-members", "slack:full-members"]` includes members returned by either service.

In the `finance` example, `within = "internal"` declares that every member of `finance` is internal. OpenAPPA trusts this declaration; it does not check each member against the sources for `internal` or check their email domain. A group can declare `within = "self"` or `within = "internal"`.

You can use `"@slack:user-group/oncall"` directly instead of declaring a named group such as `@oncall` under `[policy.audience.group.<name>]`. It refers to the Slack group `oncall`. To use this reference, at least one selector must use the `slack` provider:

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

OpenAPPA rejects policy references to undeclared named audiences, providers that no `[externals.audience.<provider>]` entry declares, or selectors that match no declared template.

##### Reader IDs

A reader ID is a string that OpenAPPA compares exactly. The membership service decides the reader ID for each member: the email address the provider verified for the account, otherwise `<provider>:<id>`, such as `slack:U012345` or `github:alice`. The shipped Slack, GitHub, and Google Workspace services do this. The GitHub service reports organization and team members by profile email where the member publishes one, otherwise as `github:<login>`.

The membership service is responsible for verifying who owns an address. OpenAPPA trusts the service; it does not verify ownership itself. Two services that report the same verified address name the same reader. A member reported by provider ID merges with nothing else.

OpenAPPA converts the domain of an address to lowercase. It leaves the part before `@` unchanged, including dots and `+suffix` values. It does not merge aliases or treat personal and corporate addresses as the same reader.

Every reader ID in an answer must be a well-formed email address or `<provider>:<non-empty>` under the answering provider. An ID with a `:` before its `@` is a qualified ID, not an address. Any other value, such as `"finance"`, refuses the whole answer as an operational failure that names the provider and selector. OpenAPPA records no decision for a refused answer.

A service that reports one account under two different addresses within one operation yields two reader IDs for one person. The result is a narrower audience, never a wider one.

##### Map members with `lookup` and `readers`

By default, a provider's own service answers member lookups. Set `lookup = "<name>"` on a provider to send its member lookups to another `[externals.audience.<name>]` entry. That entry has exactly one of `readers`, `command`, or `url`. A `readers` entry is an inline table from `<provider>:<id>` to reader ID. OpenAPPA answers from that table without calling a service.

The example below maps GitHub members to corporate addresses with a `readers` table:

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

For a provider with `lookup`, OpenAPPA also looks up every group member that is not an email address. With the configuration above, the member `github:alice` reported for `org/acme/members` becomes the reader `alice@corp.com`. A `null` answer, or a member absent from a `readers` table, leaves the member as written. OpenAPPA records lookup answers with the decision like other membership responses.

A battery binds the membership service it ships in its own `appa.toml`, with the service's `selectors`. The root config keeps the `[policy.audience]` mappings. A root entry for a provider that a battery binds is a duplicate binding, and OpenAPPA rejects the configuration.

##### Source probe at start and reload

Before it serves a configuration, and before it switches to a reloaded one, OpenAPPA reads every selector the policy references once, asks each configured `lookup` entry for one member those answers owe, and applies the reader ID rule to each answer. A service that fails or returns a malformed reader ID stops the start or the reload with the provider, the selector or member, and the reason. A service that refuses its declared templates fails this probe, so a policy whose `selectors` disagree with the service never serves. A failed reload leaves the previous configuration serving. Replay does not probe.

