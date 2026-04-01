---
title: Knowledge Connectors
category: Knowledge
order: 2
description: Supported connector types, configuration, and management
lastUpdated: 2026-03-12
---

<!--
Check ../docs_writer_prompt.md before changing this file.

-->

Connectors pull data from external tools into knowledge bases on a schedule. Sync is incremental by default, so only new or changed content is processed after the first run. A connector can also be assigned to multiple knowledge bases.

Large syncs continue automatically from their last checkpoint, so they do not need to finish in a single run.

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

| Field                 | Description                                                                                     |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| GitHub API URL        | API endpoint (e.g., `https://api.github.com` for GitHub.com, or your GHE API URL)               |
| Owner                 | GitHub organization or username that owns the repositories                                      |
| Repositories          | Comma-separated repository names to sync (optional -- leave blank to sync all org repositories) |
| Include Issues        | Toggle to sync issues and their comments (default: on)                                          |
| Include Pull Requests | Toggle to sync pull requests and their comments (default: on)                                   |
| Labels to Skip        | Comma-separated labels to exclude (optional)                                                    |

Authentication uses a [personal access token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) (PAT). Incremental sync uses the `since` parameter on the issues API to fetch only items updated after the last sync.

## GitLab

Ingests issues, merge requests, and their comments from GitLab.com or self-hosted GitLab instances.

| Field                  | Description                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------- |
| GitLab URL             | Instance URL (e.g., `https://gitlab.com` or your self-hosted URL)                  |
| Group                  | GitLab group ID or path to scope project discovery (optional)                      |
| Project IDs            | Comma-separated specific project IDs to sync (optional -- leave blank to sync all) |
| Include Issues         | Toggle to sync issues and their comments (default: on)                             |
| Include Merge Requests | Toggle to sync merge requests and their comments (default: on)                     |
| Labels to Skip         | Comma-separated labels to exclude (optional)                                       |

Authentication uses a [personal access token](https://docs.gitlab.com/user/profile/personal_access_tokens/) (PAT). System-generated notes (assignment changes, label updates, etc.) are automatically filtered out. Incremental sync uses the `updated_after` parameter.

## ServiceNow

Ingests records from ServiceNow instances via the Table API. HTML descriptions are converted to plain text. Multiple entity types can be enabled via toggles.

| Field                         | Description                                                                                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Instance URL                  | Your ServiceNow instance URL (e.g., `https://your-instance.service-now.com`)                                                  |
| Include Incidents             | Sync incidents from the `incident` table (default: on)                                                                        |
| Include Changes               | Sync change requests from the `change_request` table (default: off)                                                           |
| Include Change Tasks          | Sync change tasks from the `change_task` table (default: off)                                                                 |
| Include Problems              | Sync problems from the `problem` table (default: off)                                                                         |
| Include Business Applications | Sync business applications from the `cmdb_ci_business_app` CMDB table (default: off)                                          |
| States                        | Comma-separated state values to filter by (e.g. `1, 2`). Applies to incidents, changes, change tasks, and problems (optional) |
| Assignment Groups             | Comma-separated assignment group sys_ids to filter by. Does not apply to business applications (optional)                     |
| Batch Size                    | Records per batch (default: 50)                                                                                               |

Authentication supports both basic auth (username + password) and OAuth bearer tokens. When using basic auth, provide the username in the Email field and the password in the API Token field. For OAuth, leave the Email field empty and provide the bearer token. Incidents are synced by default; enable additional entity types in the advanced configuration. States and assignment group filters apply to all entity types except business applications. Incremental sync uses the `sys_created_on` field to fetch only records created since the last run.

## Adding New Connector Types

See [Adding Knowledge Connectors](/docs/platform-adding-knowledge-connectors) for a developer guide on implementing new connector types.
