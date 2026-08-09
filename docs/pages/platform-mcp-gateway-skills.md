---
title: Publishing Skills over MCP
category: MCP
order: 6
description: Serve your organization's skills to MCP clients as skill:// resources
lastUpdated: 2026-08-10
---

A gateway can publish your organization's [skills](/docs/platform-agent-skills) to the MCP clients that connect to it. The client reads them as `skill://` resources and offers them alongside its own skills.

This implements the draft MCP Skills extension (`io.modelcontextprotocol/skills`). Turn it on with `ARCHESTRA_BETA`. It is off by default — the specification is still a draft, so the wire format may change.

`ARCHESTRA_BETA` is the deployment-wide beta switch. There is no skills-only setting, so turning it on also enables the other beta features listed in [Deployment](/docs/platform-deployment).

## What a Client Receives

A client that speaks the extension lists the gateway's skills, fetches any one of them, and reads its files. Each skill arrives as its `SKILL.md` plus its supporting files — scripts, references, and assets.

Every file carries a SHA-256 digest. A client uses the digest to verify what it downloaded and to notice when a skill changes. Digests are recorded whenever a skill is saved, so a skill that nobody edits keeps the same digest.

Resource URIs name the skill in their last path segment:

```
skill://archestra/shared/<name>/SKILL.md
skill://archestra/shared/<name>/references/GUIDE.md
```

Skills reach clients as resources. This is separate from `load_skill`, the tool Archestra's own agents use, which keeps working unchanged.

## Choosing What a Gateway Publishes

Open the gateway and use the **Published skills** control. It works like the gateway's tool control. Agents have the same control. LLM proxies and built-in agents do not.

**Auto** publishes every organization-scoped skill in the gateway's [environment](/docs/platform-environments). New organization skills appear automatically. Exclude individual ones to keep them off the surface. Auto publishes only the skills that *can* be published: an organization skill that is templated, delegates to an agent, or carries a non-conforming name is skipped without an error. Assign skills in Custom mode if you want to be told why one cannot be published.

**Custom** publishes exactly the skills you assign. Use it for team and personal skills — Auto never publishes those.

Both sets are saved separately, so switching between modes keeps the other configuration intact.

## Skills That Cannot Be Published

Six kinds of skill cannot be published. Assign one in Custom mode and you get an error naming the reason, rather than an assignment that quietly does nothing; Auto skips them without a message. The check runs when you add a skill — skills already saved never block a later save.

- **Templated skills** render per user at activation, so they have no fixed content to digest.
- **Agent-delegated skills** hand the task to a named agent, which has no counterpart over MCP.
- **Someone else's personal skills**. A personal skill is published by its author only. Your own personal skills publish from any gateway you can edit.
- **Skills outside the gateway's environment**. Both modes publish only skills the gateway's environment can see. A skill later moved to another environment drops off the gateway.
- **Skills with non-conforming names**. The [Agent Skills specification](https://agentskills.io/specification) allows lowercase letters, digits, and single hyphens — `quarterly-close`, not `Quarterly Close`. A skill named otherwise keeps working everywhere else in Archestra; rename it to publish it over MCP.
- **Skills with a file path no URI can name**, such as `docs//guide.md` with an empty segment. Only older skills have one. This is the one case with no error at assignment time — the skill is accepted and then withheld from clients. The only symptom is the skill never appearing in a client's list. Open the skill and rename the file to publish it.

## Use Case

The finance team keeps a `quarterly-close` skill describing how to reconcile ledgers. Analysts work in Claude Desktop, not in Archestra chat.

An admin sets the finance gateway to **Custom** and assigns `quarterly-close`. Each analyst's client now lists the skill and follows the same reconciliation steps the team wrote. When finance edits the skill, the digest changes and every client picks up the new version.

## Access Control

A gateway publishes skills to whoever holds its token. That includes your personal skills once you assign one — publishing is your decision as the author, and the picker says so before you confirm. Nobody else can publish your personal skill, not even an admin.

Choosing what a gateway publishes requires permission to read skills. Without it, the **Published skills** control does not appear.

You can only publish a skill you can already read. Archestra checks this when a skill is added, not on every client request. Removing someone from a team does not un-publish what they added. To withdraw a skill, remove it from the published set.

See [Access Control](/docs/platform-access-control) for the permission model.
