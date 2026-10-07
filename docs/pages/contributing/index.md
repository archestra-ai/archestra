---
title: How to Contribute
sidebarTitle: Contributing
description: Propose changes, report bugs, responsibly disclose vulnerabilities, and develop platform extensions
order: 9
lastUpdated: 2026-10-06
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Archestra accepts feature proposals and bug reports through GitHub issues. Maintainers implement accepted changes with autonomous coding agents.

- [Developer Quickstart](/docs/contributing/developer-quickstart): Run Archestra from source using Tilt and a local Kubernetes cluster.
- [Extending Archestra](/docs/contributing/extending-archestra): Add LLM providers, knowledge connectors, or vector search backends.

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
- Open a private security advisory through GitHub's [Security Advisories](https://github.com/archestra-ai/archestra/security/advisories/new). Only repository maintainers can view the advisory.

Please include:

- Affected Archestra version and deployment method (Docker or Helm).
- Detailed reproduction steps or a minimal proof of concept.
- Attack impact assessment (unauthorized data access, privilege escalation, or code execution).

## Bug Bounty

<span id="bug-bounty"></span>

Archestra does not operate a formal bug bounty program. The security team may award discretionary bounties for critical, responsibly disclosed vulnerabilities based on severity.
