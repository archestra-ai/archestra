---
title: Runtime Credentials
category: Administration
description: Manage reusable secrets for Agent Runtime
order: 5
lastUpdated: 2026-09-12
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Runtime credentials keep secret values out of Agent definitions. One saved connection can supply multiple Agents.

## Choose a Scope

A personal connection belongs to one user. It is available only when that user starts a run.

An organization connection is shared by Agents in the organization.

GitHub tokens use custom credential definitions. Existing GitHub connections and Agent bindings are preserved when upgrading.

Claude subscriptions use personal sign-in. Each user connects once across all their Claude Code Agents. See [Claude Code authentication](/docs/platform-agent-runtime#model-inference-and-mcp-tools).

On read-only Vault deployments, store a token from `claude setup-token` in Vault. Connect its `path#key` reference on the Agent.

Administrators can add definitions for other services. Each definition controls which scopes it supports.

## Define a Credential

Go to **Settings → Agents → Runtime credentials**. Add a name, description, and supported scopes.

Definitions describe the credential but do not contain its secret value.

## Connect a Value

Connect organization values from **Settings → Agents → Runtime credentials**.

Connect personal values under **Personal settings → Connections**. Archestra prompts for a missing personal value when a run starts.

Credential setup links from conversations open a dialog for all missing credentials. After saving, return to the conversation and retry your request.

Saved values are never displayed again. They use the configured [secrets manager](/docs/platform-secrets-management).

## Bind a Credential to an Agent

Open the Agent editor, go to **Advanced → Agent Runtime**, and enable **Dedicated runtime**.

Add a **Secret**, then choose its **Secret source**.

Set the environment variable expected by the image. The same connection can use `GITHUB_TOKEN` in one image and `GH_TOKEN` in another.

Choose **Agent-specific secret** to keep the value tied to one Agent.

See [Agent Runtime](/docs/platform-agent-runtime) for the image contract.

## Rotate or Disconnect

Replacing a saved connection changes future runs for every Agent bound to it.

Disconnecting a personal value makes it unavailable to that user. Deleting a credential definition is blocked while an Agent still uses it.
