---
title: Subagents
description: Let an agent delegate work to built-in subagents or to external A2A agents
order: 5
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Split big tasks across specialists. An agent, the parent, can hand part of a task to another agent, its subagent, and use the result. The parent decides on its own when to delegate.

A subagent can be:

- An agent you built, such as a researcher or a reviewer.
- A [built-in subagent](/docs/agents/subagents/built-in), such as the Advisor, which reviews an agent's answer.
- **An [external agent](/docs/agents/subagents/external)** on another system, over A2A.

![The Subagents settings on an agent](/docs/automated_screenshots/agents-subagents_agent-subagents.webp)

## Add Subagents

1. Open the parent agent and go to **Tools, Skills & Knowledge**.
2. Under **Subagents**, choose **Manual** and select the agents.
3. Save, and send a task in Chat that needs one of them.

What to know:

- **All** mode lets the parent agent use any agent the person can access, except those you exclude. External agents are never added this way.
- Subagents must share the parent agent's [environment](/docs/admin/environments).
- Automated runs, with no signed-in person, use only the agents you selected.
- For long coding tasks, pick a subagent with a [dedicated runtime](/docs/agents/runtime).
