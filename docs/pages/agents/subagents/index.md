---
title: Subagents
description: Let an agent delegate work to its own copy, your agents, built-in subagents, or external A2A agents
order: 5
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->
<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

Split big tasks across specialists. An agent, the parent, can hand part of a task to another agent, its subagent, and use the result. The parent decides on its own when to delegate.

A subagent can be:

- An agent you built, such as a researcher or a reviewer.
- **An [external agent](/docs/agents/subagents/external)** on another system, over A2A.

## Add Subagents

1. Open the parent agent and go to **Tools, Skills & Knowledge**.
2. Under **Subagents**, choose **Manual** and select the agents.
3. Save, and send a task in Chat that needs one of them.

What to know:

- **All agents** lets the parent agent use any agent the person can access, including agents created later. To leave one out, click **Exclude a local agent**. External agents are never added this way.
- External agents are added after the parent agent is created. See [External Agents](/docs/agents/subagents/external).
- Subagents must share the parent agent's [environment](/docs/admin/environments).
- Automated runs, with no signed-in person, use only the agents you selected.
- For long coding tasks, pick a subagent with a [dedicated runtime](/docs/agents/runtime).

## Agent Runtime Delegation

When a parent agent delegates to several subagents with [dedicated runtimes](/docs/agents/runtime), you can spread runs across them instead of leaving the choice to the model on every call.

1. Open the parent agent and go to **Tools, Skills & Knowledge → Subagents**.
2. Assign two or more subagents that run in an Agent Runtime (each shows its runtime icon on the badge).
3. Under **Agent Runtime Delegation**, pick a routing mode:
   - **Direct:** the model picks which subagent to call.
   - **Round robin:** rotates runs through assigned Agent Runtime subagents in turn.
   - **Weighted round robin:** splits runs by custom weights (`1` to `1000`). Available in **Manual** mode; click an assigned runtime subagent badge to set its **Load balancing weight** and see the share of runs it will receive. Each assigned runtime badge shows a thin progress bar along its top edge for its live share.
   - **Random:** picks an assigned Agent Runtime subagent at random.
4. Save your changes.

What to know:

- Subagents without a dedicated runtime are never load-balanced; they are always selected by the model.
- When load balancing is on (**Round robin**, **Weighted round robin**, or **Random**), retriable failures automatically retry twice on the same subagent and then fail over to the remaining assigned runtime subagents.
- **MCP Gateways** expose the same **Agent Runtime Delegation** setting under **Settings → Agents**. See [MCP Gateway](/docs/mcp/gateway#subagents).

## Fork the Agent

Keep long searches and noisy tool output out of the conversation. Every agent can hand a task to a fresh copy of itself, and only the copy's answer comes back. You don't need to set this up.

The agent picks the model the copy runs on for each task:

- **Normal**: the agent's own model. This is the default.
- **Smart**: a stronger model, for hard reasoning or checking a conclusion.
- **Fast**: a cheaper, quicker model, for bulk reading, searching, or extraction.

To choose the Smart and Fast models, set **Fast model** and **Smart model** next to the default model in **Settings → Agents**. They apply to every agent, can be on any provider, and are separate from an [auto router's](/docs/llm-proxy/auto-routing) own fast and smart tiers. A Normal copy of an agent on an auto router is routed by that router. Unset tiers use the provider's latest small model for Fast and its latest flagship for Smart.

What to know:

- The copy has the same tools and instructions, but none of the conversation. The agent writes everything the copy needs into the task.
- The copy uses the agent's key when that key serves the tier's model, and otherwise a key the person may use for it. With no such key, it uses the provider default for the tier on the agent's key, or else the agent's own model.
- A copy cannot fork again.

## Get Trusted Answers From Untrusted Data

Let a subagent read untrusted data, such as inbound email or a web page, without the parent losing trust. With [Guardrails](/docs/agents/guardrails) on, a parent can ask for a structured answer, such as a number of days or one choice from a fixed list. An answer that matches comes back at the parent's own trust.

What to know:

- The parent names the answer's shape when it delegates. Every field must be bounded: a number in a range, a yes or no, or a fixed list of values. Free text is never accepted.
- An answer that does not match is withheld. The parent gets an error, never the raw text.
- External agents cannot return structured answers.

## Answers the Parent Must Accept

A subagent can read a web page or an inbound email and finish its task, and the parent keeps its trust until it chooses otherwise. With [Guardrails](/docs/agents/guardrails) on, an answer that would lower the parent's trust or narrow its audience does not come back on its own. Guardrails holds it, and the parent picks one:

- **Accept:** the parent gets the answer and takes on its labels. After accepting an answer built on an untrusted web page, the parent is untrusted too.
- **Discard:** nothing of the answer reaches the parent, and its labels stay as they were.

To keep the parent's trust and still use the result, ask for a [structured answer](#get-trusted-answers-from-untrusted-data) instead.

What to know:

- An answer that changes nothing for the parent comes back directly.
- A discarded answer cannot be accepted later. The parent delegates again to get a new one.
- This covers forks and agents you built. The exceptions are a subagent with a [dedicated runtime](/docs/agents/runtime) and a subagent's own subagents: they are refused such a read instead.
