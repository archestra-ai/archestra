---
title: Tuners
description: Scheduled agents that find recurring housekeeping issues and file suggestions into one inbox for an admin to act on
order: 9
lastUpdated: 2026-11-16
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

A tuner is a scheduled agent that spots a recurring problem, such as a pod that keeps getting OOMKilled or a tool your reviewers approve every time, and files a suggestion for you. It never changes anything by itself: an admin acts on every suggestion in one inbox.

Tuners are off by default. Set [`ARCHESTRA_TUNERS_ENABLED=true`](/docs/admin/deployment/configuration#ARCHESTRA_TUNERS_ENABLED) to turn them on, then open **Tuners** in the app.

## The Two Tuners

Each tuner is a built-in agent with read-only tools.

| Tuner | Looks at | Suggestions |
| --- | --- | --- |
| **SRE tuner** | The platform's own namespace and the MCP server namespace | Notes |
| **APPA tuner** | The last 14 days of Guardrails activity | Notes and policy changes |

Before the agent runs, Archestra collects candidates: findings with a stable fingerprint. If there are none, or all of them are suppressed, the run ends successfully and never calls the LLM, so it costs no tokens.

### SRE Tuner

The SRE tuner uses the [SRE agent](/docs/admin/deployment/diagnostics#sre-agent), so it needs [`ARCHESTRA_SRE_AGENT_ENABLED`](/docs/admin/deployment/configuration#ARCHESTRA_SRE_AGENT_ENABLED). It raises a candidate for:

- a container OOMKilled in the last 24 hours;
- a container that restarted more than 5 times, with a termination in the last 24 hours;
- a pod Pending for over 10 minutes, or a container in CrashLoopBackOff, ImagePullBackOff, or ErrImagePull;
- a Deployment or StatefulSet with fewer available replicas than desired for over 10 minutes.

To lock down what the SRE agent's sandbox can reach, go to **Agents → SRE agent → Configuration → Network egress**. This needs environment update permission.

### APPA Tuner

The APPA tuner is a built-in agent next to the APPA Keeper, so it needs OpenAPPA enabled. It raises a candidate for:

- a tool that human reviewers approved at least 5 times and never denied;
- a tool with at least 3 human denials;
- a tool the policy denied at least 5 times across at least 2 sessions;
- an unresolved yell. Waiver yells are grouped per tool, and each agent yell stands alone;
- a tool auto-approved by an `approve` authority at least 5 times.

What to know:

- Counts are lower bounds. The tuner cannot see encrypted chats.
- With metadata-only consult logging, human approve and deny rulings cannot be read, so the two human-review sources find nothing.

## Act on Suggestions

Open **Tuners**, review each suggestion, and either apply it or close it. Every suggestion has a severity of info, warn, or critical, and a status:

| Status | Meaning |
| --- | --- |
| **Open** | Waiting for an admin. There is at most one open suggestion per issue. |
| **Done** | You handled it. |
| **Rejected** | You declined it. A comment is required, and the tuner reads it on its next run. |
| **Published** | A policy change is in an open pull or merge request. |
| **Effective** | A policy change is live. |
| **Resolved** | The issue went away while the suggestion was open. |

Done and rejected suggestions silence that issue for 14 days, unless its severity goes up.

### Policy Changes

A policy change is an exact-text edit to the Guardrails policy. Review its diff, then apply it. Applying needs [`guardrailsPolicy:update`](/docs/reference/permissions#guardrailsPolicy:update) as well.

- **Locally managed policy:** applying saves a new revision, and the suggestion becomes effective.
- **With [Git sync](/docs/agents/guardrails/git-sync):** applying opens a pull or merge request, and the suggestion is published. It becomes effective once the request is merged and Git sync has applied it. A request closed without merging returns the suggestion to open. The tuner refreshes this on each run, and you can refresh it by hand.

What to know:

- If the policy changed after the suggestion was made, applying fails and the suggestion stays open.
- Before filing, Archestra checks that the policy revision matches, the edits apply, no line holds a credential, and the policy validates. It replays your saved validations against the draft, and a failing validation means the change is not filed.
- With no saved validations, no replay available, or a validation that cannot run, the suggestion is filed and marked **unverified**, with the reason. Your review of the diff is the real check.

## Schedule and Run a Tuner

Each tuner runs daily at 06:00 UTC by default. You can enable or disable it, edit its cron expression and timezone, or run it on demand.

What to know:

- Whoever enables a tuner becomes the user it runs as. Each run rechecks that this user still has the permissions, and fails otherwise.
- During a run, the agent can use only the tools assigned to it and the suggestion tool. It cannot delegate to other agents or skills, ask users, or discover and dispatch tools.

## Permissions

The **Tuners** resource has two permissions, and both also require organization-wide log access ([`log:admin`](/docs/reference/permissions#log:admin)):

- [`tuner:read`](/docs/reference/permissions#tuner:read) views tuners and suggestions.
- [`tuner:update`](/docs/reference/permissions#tuner:update) enables, schedules, and runs tuners, and acts on suggestions.

The Admin role has both. Editor and Member do not. Existing custom roles do not get them automatically: add them in the role editor.

Every admin action and every filed suggestion is recorded in the audit log.
