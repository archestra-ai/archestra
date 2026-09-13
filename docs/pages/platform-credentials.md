---
title: Credentials
category: Administration
description: Save credentials once and reuse them across agents, MCP servers, skills, and knowledge
order: 5
lastUpdated: 2026-09-13
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

![Personal and organization credentials](/docs/automated_screenshots/platform-credentials_overview.webp)

Credentials supply authentication to Agent Runtime, MCP servers, skills, plugins, and Knowledge connectors. Manage them under **Settings → Credentials**. Credentials are available without enabling Agent Runtime.

## Credential Types

A **Custom secret** holds one value, such as a GitHub personal access token. The integration determines how that value is used.

A **GitHub App** always belongs to the organization. It holds an API URL, app ID, installation ID, and private key. Archestra uses the private key to request an installation token. Agent and MCP environments receive the token, never the private key.

[Installation tokens expire after one hour](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app). Running processes do not refresh their environment automatically. Use a custom secret for processes that need longer uninterrupted access.

Install the GitHub App on the repositories it needs. Its installation permissions determine the token's access. Individual integrations describe their required permissions.

## Ownership

Every credential definition has a name, description, type, and owner policy. Its saved values are separate from that definition.

**Each user** means every person connects their own private value. Agent Runtime uses the person acting on the run. MCP servers use the owner of a personal installation. Another user's value is never substituted.

**The organization** means an administrator connects one shared value. Scheduled skill, plugin, and Knowledge syncs use organization credentials.

Create separate definitions when the same service needs both ownership policies. A personal MCP credential cannot be used by an organization installation.

## Storage

Connect both personal and organization values from **Settings → Credentials**. **Settings → Secrets** configures the storage provider.

Saved values use the configured [secrets manager](/docs/platform-secrets-management). Archestra stores them in its database or Vault. Read-only Vault deployments store references to existing secret fields.

Select the Vault path and key when connecting a value. The same reference works wherever the credential is selected. Integrations read values through the secrets manager at execution time.

The Credentials page shows connection status without revealing saved values. LLM provider accounts and native Claude subscriptions retain their dedicated sign-in flows.

## Using Credentials

Agent Runtime and MCP environment editors share the same **Secret source** selector. Choose a saved credential and enter the variable name expected by the runtime. One credential can supply `GITHUB_TOKEN` in one resource and `GH_TOKEN` in another.

A resource-specific secret supplies only that resource. Use a saved credential when several resources need the same value.

GitHub skill and plugin imports accept saved secrets as tokens or saved GitHub Apps. GitHub Knowledge connectors select an organization credential. See [Skills](/docs/platform-agent-skills), [Plugins](/docs/platform-agent-plugins), and [Knowledge](/docs/platform-knowledge#github) for repository setup.

## Rotation And Disconnection

Replacing a value updates future resolutions wherever the credential is referenced. Restart existing MCP processes or start a new Agent Runtime run to update environment variables.

GitHub App installation tokens expire after one hour. An environment variable contains the token resolved when its process starts. Long-running processes need a new execution before that token expires. Skill and Knowledge operations resolve tokens when they authenticate.

Disconnecting removes a saved value without removing its definition. Required bindings need a connected value before execution. Deleting a definition is blocked while a resource references it.

## Use Case: One GitHub Credential Across Integrations

Save a GitHub token as an organization **Custom secret** named **Repository access**. Connect its value once.

Select **Repository access** for a coding Agent's `GITHUB_TOKEN` environment variable. Select it again for a GitHub MCP server's `GITHUB_PERSONAL_ACCESS_TOKEN` variable. Use the same credential for private skill imports or a GitHub Knowledge connector.

For personal repository access, create a credential provided by **Each user** instead. Each person connects their token and selects it for their own Agent runs and MCP installation.

A GitHub App follows the same reuse pattern. Save its installation details, connect the private key, and select the credential in each integration.

## Upgrading

Existing GitHub tokens become custom secrets. GitHub App configurations and runtime connections move into the shared credential store. Existing secret references and skill or plugin links are preserved.

This migration requires a coordinated upgrade. Stop older application replicas before applying it. Start the updated replicas after the migration completes.
