# Detail pages: the numbers

Applies to every entity surface: agents, skills, LLM proxies, MCP gateways, MCP registry.

**Header actions.** 1 primary button, at most 2 secondary, everything else in the kebab.
Destructive items sit last, below a divider. An unavailable action stays visible and disabled
with a reason; it is never removed.

**Counters.** No counter without a named denominator: "12 of 40 tools", never "12 tools".
If the denominator cannot be named, show the list instead of a number.

**Type roles.** 8 roles from `lib/design/type-scale.ts`, base 14px, hierarchy from weight:
`page-title` `page-description` `section-title` `label` `body` `meta` `metric` `code`.
Body copy is never muted. `meta` never carries a string the user must read to decide.
`tabular-nums` on any number that updates live. At most 3 roles per card. No `text-[Npx]`.

**Tabs.** 2 to 5. The first is the default and answers "what is this" with no further clicks.
The set is fixed per entity type; a tab with nothing to show says so. Every tab is
addressable by URL.
