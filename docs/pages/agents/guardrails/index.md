---
title: Guardrails
description: Stop agents from leaking data, with OpenAPPA policies on every tool call
order: 1
beta: "Policy syntax and behavior may change as OpenAPPA evolves."
lastUpdated: 2026-10-20
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Guardrails check every tool call an agent makes against your organization's policy, before the call runs. So an agent that has read an untrusted web page cannot then email your customer list. The [OpenAPPA](https://www.openappa.com/) policy engine decides by rules, not by asking another model. It runs outside the agent's loop, so a prompt injection cannot change its decisions.

> **Platform + AI Security** — see [Pricing Model](/docs/get-started/pricing-model#platform--ai-security). OpenAPPA itself is MIT-licensed; its integration here is the licensed part. Once the instance has 30 or more users, the integration turns off until [`ARCHESTRA_ENTERPRISE_LICENSE_AI_SECURITY_ACTIVATED`](/docs/reference/configuration#ARCHESTRA_ENTERPRISE_LICENSE_AI_SECURITY_ACTIVATED) is set.

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

When a tool's *requirements* don't match the session's *label*, the call is blocked. An *authority*, such as the person running the session, can approve it, or a *sanitizer* can clean the data first. Otherwise it stays blocked, and the agent explains why. See [the core concepts](https://www.openappa.com/how-it-works#the-core-concepts) for details.

<a id="configure-with-the-agent"></a>

## Turn On Guardrails

The configuration agent writes your first policy from the tools you already have. You need [`guardrailsPolicy:update`](/docs/reference/permissions#guardrailsPolicy:update) to write the policy, and [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update) to turn enforcement on or off. **Guardrails** appears under **Agents** in the sidebar for anyone with [`guardrailsPolicy:read`](/docs/reference/permissions#guardrailsPolicy:read) or [`log:read`](/docs/reference/permissions#log:read).

1. Go to **Guardrails** and click **Create my policy**. A chat with the configuration agent opens.
2. The agent drafts a starting policy from your tools and explains what it allows and blocks.
3. Approve the policy. Saving the first policy turns enforcement on.

The Guardrails page header now shows **Enforcement on**.

What to know:

- The starting policy has rules for Archestra's own tools and for the built-in tools of Claude Code, Codex, and OpenCode. Every other tool call goes to the annotator model: the one under **Annotator model** in **Settings → Guardrails**, or your organization's default model. If no model can answer, the call is refused.
- Enforcement applies to sessions that start while it is on. Start a new session after you turn it on. The same holds for an [Agent Runtime](/docs/agents/runtime/handoff#hand-off-with-guardrails-on) run.
- To turn enforcement off again, switch **Enforce the policy** in **Settings → Guardrails**. Every other setting there is explained on the page where you use it.

**Next:** [Change the policy](/docs/agents/guardrails/policies) to cover your other tools.
