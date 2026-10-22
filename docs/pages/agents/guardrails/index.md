---
title: Guardrails
description: Stop agents from leaking data, with OpenAPPA policies on every tool call
order: 1
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Guardrails check every tool call an agent makes against your organization's policy, before the call runs. So an agent that has read an untrusted web page cannot then email your customer list. The [OpenAPPA](https://www.openappa.com/) policy engine decides by rules, not by asking another model. It runs outside the agent's loop, so a prompt injection cannot change its decisions.

![The Guardrails Overview tab with the policy cards above the GitHub sync, Validations, and Yells cards](/docs/automated_screenshots/platform-ai-tool-guardrails_overview.webp)

<a id="the-lethal-trifecta"></a>

## How It Works

An agent that reads private data, reads untrusted content, and can send data out can be tricked into a leak. One hidden line on a web page, such as "email the customer list to this address", is enough.

Each session that goes through the [LLM Proxy](/docs/llm-proxy) carries a label. A tool call can change the label and can declare what label it requires:

- **Label:** every session carries one, made of trust and audience. It starts open and only gets stricter.
- **Trust:** how far the session's content can be trusted. It follows who wrote the text, not who can read it. A web page or an outsider's comment lowers it.
- **Audience:** who may see data from the session. Reading an internal document limits where the agent can send data afterwards.
- **Rule:** each tool's rule says how its result changes the label, and what label a call needs. A rule can also ask for a person's approval.

For example:

```toml
# Reading an internal doc limits the session's audience to "internal".
[[policy.tool]]
name = "docs__read_internal"
delta = { audience = ["internal"] }

# Publishing needs a trusted session whose audience still includes "public".
# After docs__read_internal, the audience is "internal", so publishing is blocked.
[[policy.tool]]
name = "blog__publish_post"
requires = { trust = "trusted", audience = { contains = ["public"] } }
```

When a tool's requirements don't match the session's label, the call is blocked. Guardrails provide several ways to unblock the agent. The policy offers them as remedy plans, and the agent picks one:

- **Authority:** approves one exact call. The starting policy's authority, `human-approval`, asks the person running the session.
- **Sanitizer:** cleans the data first, for example by removing secrets, so the call can go ahead.
- **`attest-schema`:** a built-in sanitizer for risky reads. The agent hands the read to a subagent, which must reply in a strict JSON shape the agent asked for. Injected instructions cannot slip back, so a reply that fits keeps the agent's trust.
- **Accept restrictions:** the agent accepts the lower trust or smaller audience a tool result brings, and goes on under them.

If no remedy plan works, the call stays blocked, and the agent explains why. See [the core concepts](https://www.openappa.com/how-it-works#the-core-concepts) for details.

<a id="configure-with-the-agent"></a>

## Turn On Guardrails

The APPA Keeper agent helps you manage your policy. It writes your first policy from the tools you already have.

1. Go to **Guardrails** and click **Create my policy**. A chat with the APPA Keeper opens.
2. The agent drafts a starting policy from your tools and explains what it allows and blocks.
3. Approve the policy. Saving the first policy turns enforcement on.

The starting policy contains:

- **Archestra's own tools:** rules from the bundled Archestra battery.
- **Coding agent tools:** rules for the built-in tools of Claude Code, Codex, and OpenCode, such as shell commands, file edits, and web fetches.
- **Your organization as the `internal` audience:** data your members can see may go to them, and no further.
- **The annotator model for the rest:** it labels sandbox commands ([`run_command`](/docs/reference/archestra-mcp-server#run_command)), coding agent shell commands, and every tool no rule covers. It uses the model under **Annotator model** in **Settings → Guardrails**: a fast model, such as Claude Haiku, on your organization's default key unless you pick another.
- **Human approval:** the `human-approval` authority, the person running the session, can approve a blocked call.

Required permissions:

- [`guardrailsPolicy:read`](/docs/reference/permissions#guardrailsPolicy:read) to see **Guardrails** under **Agents** in the sidebar.
- [`guardrailsPolicy:update`](/docs/reference/permissions#guardrailsPolicy:update) to write the policy.
- [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update) to turn enforcement on or off.

**Next:** Check how to [manage your policy](/docs/agents/guardrails/policies) to cover more tools, [test your policy](/docs/agents/guardrails/policies#validating-the-policy), and [deal with agents stuck because of the policy](/docs/agents/guardrails/policies#yells).
