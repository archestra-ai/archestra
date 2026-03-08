---
title: Knowledge Connectors
category: Knowledge
order: 2
description: Supported connector types, configuration, and management
lastUpdated: 2026-03-06
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Connectors pull data from external tools on a cron schedule into knowledge bases. Each connector tracks a checkpoint for incremental sync -- only changes since the last run are processed. A connector can be assigned to multiple knowledge bases.

In local development (no K8s), connector syncs run in-process. In production, each sync runs as a Kubernetes CronJob in the Helm release namespace by default (configurable via `ARCHESTRA_KNOWLEDGE_BASE_CONNECTOR_K8S_CRONJOB_NAMESPACE`).

For large data sources, sync runs are time-bounded. When a run exceeds 90% of the configured max duration (`ARCHESTRA_CONNECTOR_SYNC_MAX_DURATION_SECONDS`, default 55 minutes), it saves its checkpoint and triggers a continuation job to resume from where it left off. This repeats automatically (up to 50 continuations) until all data is synced. The UI shows progress with estimated total item counts where available.

## Jira

Ingests issue descriptions, comments, and metadata from Jira Cloud or Server.

| Field                   | Description                                                        |
| ----------------------- | ------------------------------------------------------------------ |
| Base URL                | Your Jira instance URL (e.g., `https://your-domain.atlassian.net`) |
| Cloud Instance          | Toggle on for Jira Cloud, off for Jira Server/Data Center          |
| Project Key             | Filter issues to a single project (optional)                       |
| JQL Query               | Custom JQL to filter issues (optional)                             |
| Comment Email Blacklist | Comma-separated emails whose comments are excluded (optional)      |
| Labels to Skip          | Comma-separated issue labels to exclude (optional)                 |

Authentication uses an Atlassian account email and [API token](https://id.atlassian.com/manage-profile/security/api-tokens). Incremental sync uses JQL time-range queries on the `updated` field.

## Confluence

Ingests page content (HTML converted to plain text) from Confluence Cloud or Server.

| Field          | Description                                                                   |
| -------------- | ----------------------------------------------------------------------------- |
| URL            | Your Confluence instance URL (e.g., `https://your-domain.atlassian.net/wiki`) |
| Cloud Instance | Toggle on for Confluence Cloud, off for Server/Data Center                    |
| Space Keys     | Comma-separated space keys to sync (optional)                                 |
| Page IDs       | Comma-separated specific page IDs to sync (optional)                          |
| CQL Query      | Custom CQL to filter content (optional)                                       |
| Labels to Skip | Comma-separated labels to exclude (optional)                                  |
| Batch Size     | Pages per batch (default: 50)                                                 |

Authentication uses the same Atlassian email + API token as Jira. Incremental sync uses CQL `lastModified` queries.

## GitHub

Ingests issues, pull requests, and their comments from GitHub.com or GitHub Enterprise Server.

| Field                  | Description                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| GitHub API URL         | API endpoint (e.g., `https://api.github.com` for GitHub.com, or your GHE API URL)                   |
| Owner                  | GitHub organization or username that owns the repositories                                           |
| Repositories           | Comma-separated repository names to sync (optional -- leave blank to sync all org repositories)      |
| Include Issues         | Toggle to sync issues and their comments (default: on)                                               |
| Include Pull Requests  | Toggle to sync pull requests and their comments (default: on)                                        |
| Labels to Skip         | Comma-separated labels to exclude (optional)                                                         |

Authentication uses a [personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) (PAT). Incremental sync uses the `since` parameter on the issues API to fetch only items updated after the last sync.

## GitLab

Ingests issues, merge requests, and their comments from GitLab.com or self-hosted GitLab instances.

| Field                    | Description                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| GitLab URL               | Instance URL (e.g., `https://gitlab.com` or your self-hosted URL)                          |
| Group                    | GitLab group ID or path to scope project discovery (optional)                              |
| Project IDs              | Comma-separated specific project IDs to sync (optional -- leave blank to sync all)         |
| Include Issues           | Toggle to sync issues and their comments (default: on)                                     |
| Include Merge Requests   | Toggle to sync merge requests and their comments (default: on)                             |
| Labels to Skip           | Comma-separated labels to exclude (optional)                                               |

Authentication uses a [personal access token](https://docs.gitlab.com/user/profile/personal_access_tokens/) (PAT). System-generated notes (assignment changes, label updates, etc.) are automatically filtered out. Incremental sync uses the `updated_after` parameter.

## Managing Connectors

Connectors can be managed from either the **Connectors** page or a knowledge base's detail page. After creation you can:

- **Toggle enabled/disabled** -- suspends or resumes the cron schedule
- **Trigger sync** -- runs an immediate sync outside the schedule
- **View runs** -- see sync history with status, document counts, and errors

The knowledge base and connector list pages show which Agents and MCP Gateways are assigned to each connector.

## Adding New Connector Types

See [Adding Knowledge Connectors](/docs/platform-adding-knowledge-connectors) for a developer guide on implementing new connector types.
