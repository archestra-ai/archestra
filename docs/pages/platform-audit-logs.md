---
title: Audit Logs
category: Administration
order: 10
description: Organization-wide record of administrative actions
lastUpdated: 2026-07-23
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

The audit log records administrative actions across your organization — agent edits, role changes, sign-ins. Viewing it requires the `auditLog:read` permission, which admins have. See [Access Control](./platform-access-control).

Find it under **Logs → Audit**.

## Events

Each event records the actor, the action, the affected resource, and the time. Key resource types show their name in the list — the "Payroll Assistant" agent, for example. Open an event to see the resource's full name, ID, and the before/after diff.

Names are captured when the event happens. Renaming or deleting an entity later does not change its past events.

## Filters

The filter bar narrows events by resource, actor, action, outcome, and time. The resource filter covers agents, MCP servers, teams, roles, environments, apps, and skills. It includes deleted agents, so their history stays reachable. Search matches actor and resource names.

Filters live in the page URL. Copy the URL to share a filtered view — or a single event — with another admin.

## Retention

Events are kept indefinitely by default. Set a retention window with `ARCHESTRA_AUDIT_LOG_RETENTION_DAYS` — see [Deployment](/docs/platform-deployment#audit-log-configuration).

## Use Case: Who Changed the Payroll Agent?

The Payroll Assistant agent starts flagging every invoice. Dana, an admin, suspects a prompt change:

- **Filter by resource**: Payroll Assistant. The list shows an `Agent updated` event from yesterday.
- **Open the event**: the actor is a teammate, and the diff shows the edited system prompt.
- **Share**: the event URL goes into the team channel to discuss the change.
