---
title: How to Contribute
sidebarTitle: Contributing
description: Propose changes, report bugs, responsibly disclose vulnerabilities, and develop platform extensions
order: 9
lastUpdated: 2026-10-15
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Report a reproducible bug, propose a feature, or work on an accepted change through GitHub. Maintainers use autonomous coding agents to implement accepted changes.

For code changes, read the repository's `AGENTS.md` and the matching `.agents/skills/` instructions. The [Developer Quickstart](/docs/contributing/developer-quickstart) runs a local stack; [Extending Archestra](/docs/contributing/extending-archestra) covers provider and Knowledge integrations.

## Opening an Issue

Open an issue on [GitHub](https://github.com/archestra-ai/archestra/issues/new/choose) using the matching template:

- **Create an issue:** Report a bug or propose changes to existing behavior. Include reproduction steps, your Archestra version, and whether you run Docker or Helm.
- **Add an LLM provider:** Request or plan support for a new model provider.
- **Add a knowledge connector:** Propose a new data source connector for knowledge bases.
- **Add an MCP server to the catalog:** Submit a new server to the public MCP catalog.

## Talking to the Team

Before drafting a large architectural change, discuss your proposal in the **#general** channel of our [Slack community](https://archestra.ai/join-slack).

## Reporting a Vulnerability

<span id="security"></span>

Report security vulnerabilities privately. Never report security issues in public GitHub issues, pull requests, or Slack channels.

Submit reports through either channel:

- Email **security@archestra.ai**.
- Open a private security advisory through GitHub's [Security Advisories](https://github.com/archestra-ai/archestra/security/advisories/new). GitHub keeps the report private to its participants.

Please include:

- Affected Archestra version and deployment method (Docker or Helm).
- Detailed reproduction steps or a minimal proof of concept.
- Attack impact assessment (unauthorized data access, privilege escalation, or code execution).

## Bug Bounty

<span id="bug-bounty"></span>

Archestra does not operate a formal bug bounty program. The security team may award discretionary bounties for critical, responsibly disclosed vulnerabilities based on severity.
