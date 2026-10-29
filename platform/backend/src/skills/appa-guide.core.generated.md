# Policy-writing rules

These rules apply on every host. They name operations, not tools: read the
policy, publish a change, and run the runtime's remedy tool. The host
reference maps each operation to the host's own tools.

## Source of truth

- The root config is the operator's source of truth. Root tool rules run
  before battery rules, and the first matching rule applies. Keep every
  root rule unless the operator explicitly approves changing or removing
  it.
- A battery supplies maintained defaults. Never edit a battery. Override
  a tool contract with a root rule. Override an Annotator by copying its
  complete declaration into the root config under the same name. Preserve
  its implementation, inputs, and mandate unless the approved behavior
  requires changing them. Do not remove overlapping root rules; they
  intentionally override batteries.
- A battery contract is also source material when a host classifier must
  recognize equivalent use through another tool. Translate the contract's
  policy intent, not its MCP enforcement mechanism. Use only facts the host
  call or an actual context provider supplies. Never invent resource
  visibility, readers, account identity, or provider context.
- A battery is available when its files exist in an inspected battery
  layer. It is included only when serving root policy includes its
  `appa.toml`. Say "include" rather than "install" when proposing that
  policy change. Never describe a catalog entry as an installed tool or
  an included battery.
- Inspection cannot see connector accounts. The operator supplies an
  account identity when a connector does not expose one. Do not probe
  private mail, messages, or files merely to infer an identity.
- Configure the installed OpenAPPA only. Never propose changing OpenAPPA,
  its policy language, runtime, or shipped batteries. If documented
  configuration cannot express the requested behavior, say so and offer
  only behaviors the current config format supports.
- Do not configure the configuring actor: skip the agent running this
  skill and the runtime-owned tools, such as the runtime's remedy tool
  and its battery matcher.

## Labels first

IFC monoids first: express boundaries with trust and audience labels.
Do not use effects or default human attention when labels can express
the same requirement. Trusted data flowing within its audience stays
autonomous. A state-changing action does not require a person by default.
Require approval only when the operator independently requests per-call
review or existing root policy requires it. Never use attention as a
substitute for an audience or trust boundary.

## Proposal and approval

- Read before proposing. Show the complete proposed behavior in plain
  English and wait for approval before writing any file or reloading the
  runtime. Ask for approval again if a correction changes that behavior.
- An initial request for a change is not approval to execute it. End the
  first turn with the proposal. Act only after a later message approves
  that exact proposal.
- If the current config already provides the complete proposed behavior,
  report that no change is needed. Do not ask for approval, write, or
  reload an unchanged config. Do not call the config updated or tell the
  operator to start a new chat when nothing changed.
- Make the smallest change that achieves the request. Preserve unrelated
  entries, comments, reader names, external bindings, and batteries.
- Call the runtime's remedy tool only when the immediately previous tool
  result quoted `offer_id: "<hex>"`. Copy that hex string exactly. Never
  invent an offer id. Never use `human-approval`, an authority name, a
  tool name, or any other word as an offer id. Never ask the operator
  for an offer id.
- When the operator sends an approval (e.g. "Approve", "Approved", "yes",
  or approving the proposal) after a proposal was presented, that proposal
  is waiting: proceed immediately with applying it. Only if the operator
  says approve and no proposal is waiting, say that nothing needs applying.
  Do not write, reload, or call the runtime's remedy tool before approval.
- Inspection and proposal drafting never require approval. Never say
  "awaiting approval to propose", "approval to refine", or equivalent.
  End an inspection in exactly one state: present the complete change
  proposal and ask for approval, or state that no change is required and
  use no approval language.

## Talk to the operator

- Use short sentences. Explain what data stays private, what can leave
  the session, what needs approval, and what becomes blocked.
- When asking for approval of a remedy, say in one sentence what the call
  does and ask for approval on the card.
- Talk about outcomes in plain words, not config machinery: say "Slack
  messages need your approval," not "the config needs a HITL authority."
  Say an agent is "protected with OpenAPPA" or "currently unprotected".
  Mention include lists, rule ordering, TOML fields, reader names, labels,
  or authority wiring only when the operator asks. Show TOML only when
  asked.
- Keep replies short and use everyday words. Explain the practical result and
  next step; save technical details for when the operator asks. If a host
  requires an **OpenAPPA pieces** line, use plain words there too.
- Tools in the config that this session did not detect: "These tools are
  in your config but were not detected in this session: <names>. I'll
  leave them unchanged."
- Ask one focused question at a time. Do not make the operator classify
  every tool when its name and description already make the answer
  clear.
- Keep user-facing replies compact. Do not narrate inspection calls,
  deployment resources such as releases or pods, config paths, counts, or
  the complete tool or battery catalog unless one changes the result.
  Group tools by server and behavior. Use one short sentence or bullet per
  outcome, plus required unavailable-resource and missing-support
  warnings. Offer technical details only when the operator asks.

## Propose a battery

When proposing a battery, give it exactly one short sentence that says what it
covers, what protection it adds, and any important assumption. Keep it under
20 words. Examples:

> Slack battery — Keeps Slack data private and asks before publishing it.
>
> GitHub battery — Assumes every repository is public and prevents private data from leaking to GitHub.

## Battery support

- Add any root support the battery requires, such as its human-approval
  Authority. If an existing `builtin hitl` Authority handles the relevant
  attention mark but cannot review public audiences, expand its permits
  instead of adding another Authority. Do not modify an explicit hard denial.
  Describe the resulting behavior, not this wiring.
- When the battery binds an Annotator or an audience source, name the
  variable it reads, `APPA_PROVIDER_<PROVIDER>_TOKEN` as its README
  states. The helper receives it through its environment, supplied by the
  runtime, never the policy config. Map `self` and `internal` onto the
  source's collections under `[policy.audience]` as the README shows.

## Cover the remaining tools

Create root rules only for the tools that reading the policy shows as judged
call by call or refused, and that no suggested battery covers. For each tool,
decide two things from its name and description:

- As a source: can someone other than the requester write the text it returns?
  Then it is `suspicious`.
- As a sink: who can end up reading what the call sends? A reader the session
  cannot see is `public`.

Apply these rules:

- The reserved `blocked` mark denies a call outright and no Authority can
  permit it; use it only where a sanitizer that would make the flow safe does
  not exist.
- A tool whose result someone other than the requester can write (a web page,
  a public issue, another session's message) uses
  `delta = { trust = "suspicious" }`.
- The built-in audience chain is `self` ⊆ `internal` ⊆ `public`: `self` is the
  person running the session, `internal` their organization.
- A tool that reads the requester's private data uses
  `delta = { audience = ["self"] }`.
- A tool that reads organization-wide data uses
  `delta = { audience = ["internal"] }`.
- Static contracts can reference `self` and `internal` without an audience
  source. Checking a literal recipient against either audience requires an
  explicit audience source.
- A tool that reads or writes one resource whose readers a source can list
  (a Slack channel, a GitHub repository, a Linear team) uses a selector
  placeholder instead of `internal`: `delta = { audience = ["@slack:channel/$channel_id"] }`
  for a read, `requires = { audience = { contains = ["@slack:channel/$channel_id"] } }`
  for a write. The spelling must match a template the provider declares under
  `selectors` on its `[externals.audience.<provider>]` binding; each
  `$argument` becomes a required string argument of the contract, so no
  `parameters` schema is needed for it. Use it whenever the matched battery
  declares such a template.
- An annotator's answer writes an audience as a static contract does: `self`,
  `internal`, an `@` mention, or a literal reader, inside its mandate's
  `audiences`. Omitted, the mandate admits every audience the policy writes.
- A tool that publishes, posts, sends, shares, or uploads beyond the machine
  requires data that may be public: `requires = { audience = { contains = ["public"] } }`.
  A destination that stays private to the requester until they share it
  themselves reaches `self` and needs no `requires`.
- A tool that communicates within the organization (e.g. posting internal Slack
  messages or workspace items) requires trusted data that includes `internal`:
  `requires = { trust = "trusted", audience = { contains = ["internal"] } }`. This
  keeps autonomous agent flow unblocked for public or internal data while preventing
  requester secrets (`self`) from leaking.
- A clearly public read or a tool whose result carries no data uses
  `delta = {}`.
- Every new tool entry needs `delta`, including entries with `requires`. Never
  fabricate reader names, groups, or audiences, and never substitute
  `"private"`, `@company`, or another plausible reader or group for `self`
  or `internal`.

For public-audience requirements, reuse an appropriate `builtin hitl`
Authority and extend its audience permit instead of adding attention solely
to route reviews. Preserve hard denials when the operator requested them, a
root rule or comment declares them, or a mark is intentionally unserved. If
multiple Authorities can review a disclosure and the choice determines who
reviews it, ask the operator.

For several root rules with the same tool name, order matters. Put a narrow
argument-specific rule before its general fallback. Do not reorder unrelated
rules.

To make an audience mismatch reviewable, permit the intended Authority to
review that audience expansion. Do not add attention only to route the review.
Keep an existing attention requirement when it represents an independent
per-call review.

## Ask about ambiguity

Use tool names and descriptions when their behavior is clear. If you still
cannot tell which servers can return data that should stay private, ask the
operator once. Put every unclear server in one grouped question. Do not guess
and do not ask about each tool separately.

Wait for the answer before showing the proposal. This answer does not replace
the approval a change requires. If nothing is unclear, do not ask.

An email domain is not an audience source: `internal` needs a
directory-backed source that can enumerate its members. Without one, say
recipient-checked sends are refused as unanswerable and leave them so. Do
not invent a group.

## Tune the defaults

The shipped defaults trade safety against interruptions, and the
operator may move that line either way. When they ask for stricter or
looser behavior, offer the matching options from the host reference.
Explain each option's behavior and cost in plain words. Each one is a root
rule or a change to one root declaration. Mark it with a comment
`# appa-guide: <option>` so a later "undo <option>" removes exactly that.
Apply one through the `adjust` steps.

When the operator asks for something no option covers, work it out from the
source and sink questions in **Cover the remaining tools**, and name its cost
the same way.

## Explain a block

After the host reference finds the blocked call and reads the policy for its
tool:

1. Read the root config and the included batteries in include order. The first
   rule whose name and argument selector match the call decides it. Selectors
   match the argument as written, case-sensitively, and `*` spans `/`.
2. In one to three sentences, say what the session had read that set its
   label, what the rule requires, and why the two differ. Name the way forward
   the block offered, if any.
3. If the operator wants the call to run in future, propose the narrowest
   change, naming a **Tune the defaults** option when one fits, and continue
   as `adjust`. Otherwise stop: explaining changes nothing.

## Publish and finish

The runtime checks the whole config before installing it. If a publish is
refused, the previous config keeps serving. Explain the error plainly and fix
it. Ask for approval again if the fix changes the behavior the operator
approved.

After a successful publish, give a brief human-readable summary of the
behavior now in effect: one to three short sentences on what information
is private or suspicious and where private information can or cannot go.
Do not lead with rule counts, file paths, TOML, backups, or primitive
names. If the config changed, tell the operator that sessions keep the
policy they started with and new ones pick up the new policy.
