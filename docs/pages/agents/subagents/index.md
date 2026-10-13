---
title: Subagents
description: Let an agent delegate work to its own copy, your agents, built-in subagents, or external A2A agents
order: 5
lastUpdated: 2026-10-07
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Split big tasks across specialists. An agent, the parent, can hand part of a task to another agent, its subagent, and use the result. The parent decides on its own when to delegate.

A subagent can be:

- An agent you built, such as a researcher or a reviewer.
- **An [external agent](/docs/agents/subagents/external)** on another system, over A2A.

## Add Subagents

1. Open the parent agent and go to **Tools, Skills & Knowledge**.
2. Under **Subagents**, choose **Manual** and select the agents.
3. Save, and send a task in Chat that needs one of them.

What to know:

- **All** mode lets the parent agent use any agent the person can access, including agents created later. To leave one out, click **Exclude a local agent**. External agents are never added this way.
- External agents are added after the parent agent is created. See [External Agents](/docs/agents/subagents/external).
- Subagents must share the parent agent's [environment](/docs/admin/environments).
- Automated runs, with no signed-in person, use only the agents you selected.
- For long coding tasks, pick a subagent with a [dedicated runtime](/docs/agents/runtime).

## Fork the Agent

Keep long searches and noisy tool output out of the conversation. Every agent can hand a task to a fresh copy of itself, and only the copy's answer comes back. You don't need to set this up.

What to know:

- The copy has the same tools and instructions, but none of the conversation. The agent writes everything the copy needs into the task.
- A copy cannot fork again.

## Get Trusted Answers From Untrusted Data

Let a subagent read untrusted data, such as inbound email or a web page, without the parent losing trust. With [Guardrails](/docs/agents/guardrails) on, a parent can ask for a structured answer, such as a number of days or one choice from a fixed list. An answer that matches comes back at the parent's own trust.

What to know:

- The parent names the answer's shape when it delegates. Every field must be bounded: a number in a range, a yes or no, or a fixed list of values. Free text is never accepted.
- An answer that does not match is withheld. The parent gets an error, never the raw text.
- External agents cannot return structured answers.
