---
title: How to Contribute
sidebarTitle: Contributing
description: Propose a change or report a bug through a GitHub issue.
order: 9
sidebarChildren: false
lastUpdated: 2026-10-05
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra takes contributions as human-written text, not code. You describe a bug or a change in a GitHub issue. Maintainers implement accepted changes with coding agents. CI closes pull requests from forks automatically. The guides in this section show how maintainers make common changes.

## Opening an Issue

Go to [New issue](https://github.com/archestra-ai/archestra/issues/new/choose) and pick a template:

- **Create an issue:** a bug or a change to existing behavior.
- **Add an LLM provider:** a model provider that Archestra does not support yet.
- **Add a knowledge connector:** a data source to sync into knowledge bases.
- **Add an MCP server to the catalog:** a new entry in the MCP Catalog.

For a bug, give the steps you took, what you expected, and what happened instead. Include the Archestra version and whether you run it with Docker or Helm. For a change, describe the problem before the solution you have in mind.

## Talking to the Team

Before you write a large proposal, post in **#general** in the [Slack community](https://archestra.ai/join-slack). The team may already have plans for the same area.

## Reporting a Vulnerability

Never report a vulnerability in a public issue. Follow [Security & Bug Bounty](/docs/contributing/security) instead.
