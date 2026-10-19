---
title: Contributing
description: Propose changes and report bugs through GitHub issues, and report vulnerabilities privately
order: 9
lastUpdated: 2026-10-19
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Tell us what to build, and we build it. Describe the change in a GitHub issue. If the maintainers agree, they implement it with coding agents.

Archestra takes contributions as human-written issues, not code. Pull requests from forks close automatically. The developer pages in this section are for maintainers, and for anyone who runs Archestra from source.

<span id="opening-an-issue"></span>

## Open an Issue

Open an issue on [GitHub](https://github.com/archestra-ai/archestra/issues/new/choose) and pick the template that fits:

- **Create an issue:** report a bug or propose a change. Include reproduction steps, your Archestra version, and whether you run Docker or Helm.
- **Add an LLM provider:** request support for a new model provider.
- **Add a knowledge connector:** request a new data source for knowledge bases.
- **Add an MCP server to the catalog:** request a new entry in the MCP Catalog. Maintainers add it.

Provider and connector requests need a link to the service's API documentation.

<span id="talking-to-the-team"></span>

## Talk to the Team

To discuss an idea before you file it, ask in the [Slack community](https://archestra.ai/join-slack).

<span id="reporting-a-vulnerability"></span><span id="security"></span>

## Report a Vulnerability

Report security issues privately, never in a public issue, pull request, or Slack channel. Use either channel:

- Email [security@archestra.ai](mailto:security@archestra.ai).
- Open a private [security advisory](https://github.com/archestra-ai/archestra/security/advisories/new) on GitHub. Only maintainers can see it.

Include:

- The affected Archestra version, and whether you run Docker or Helm.
- Steps to reproduce, or a minimal proof of concept.
- The impact, such as unauthorized data access, privilege escalation, or code execution.

## Bug Bounty

Archestra has no formal bug bounty program. The security team may award a bounty for a critical vulnerability that is reported privately.
