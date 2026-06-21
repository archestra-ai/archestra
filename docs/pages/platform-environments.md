---
title: "Environments"
category: Administration
description: "Isolate tools, knowledge, runtimes, and cost limits across deployment environments"
order: 3
lastUpdated: 2026-06-21
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document covers deployment Environments. Include:
- What an environment is and the implicit "Default" environment (null)
- Restricted environments and the environment:deploy-to-restricted / environment:admin permissions
- Namespace + network egress policy for server runtimes
- Environment isolation: how an environment scopes which tools and knowledge an
  agent / MCP gateway / LLM proxy can use (strict matching; Default is a peer, not
  a wildcard; built-in servers are exempt)
- How environments scope per-environment cost limits
- Link out to: agents, mcp gateway, llm proxy, knowledge connectors, costs & limits
-->

Environments partition an organization's resources so that what an agent or gateway can reach is scoped to where it runs. A "dev" gateway cannot use "prod" tools or knowledge, and spend can be capped per environment. Manage environments at **Settings → Environments**.

## The Default environment

Every organization has an implicit **Default** environment. Any resource whose environment is unset belongs to Default. Default is a real peer environment, not a wildcard: a resource in Default is not visible to a resource assigned to a named environment, and vice versa. Because everything starts in Default, isolation only changes behavior once you explicitly assign a non-default environment.

## Restricted environments

Marking an environment **restricted** gates assignment: assigning a resource to it requires the `environment:deploy-to-restricted` permission (or `environment:admin`, which implies it). The Default environment can be restricted the same way via organization settings.

## Runtime isolation

A named environment can define a Kubernetes **namespace** and a **network egress policy**. MCP server pods and agent code sandboxes for that environment are provisioned in its namespace and inherit its egress policy, keeping their network reach contained.

## Tool and knowledge isolation

An agent, MCP gateway, or LLM proxy assigned to environment `E` can only see and use:

- MCP tools whose server (catalog item) is in `E`
- knowledge connectors in `E`

Matching is strict: a resource in `E` matches only other resources in `E`, and Default matches only Default. Built-in servers (the Archestra control-plane server and Playwright) are exempt and always available.

This applies to both explicitly assigned tools/knowledge and the implicit "All tools" access mode — in both cases cross-environment resources are filtered out before they are listed or executed. In the agent dialog's explicit assignment pickers, resources from another environment are shown disabled.

## Cost limits

Cost limits and per-user default limits can be scoped to an environment. A limit on environment `E` only counts usage attributed to `E` (an interaction's environment is snapshotted from its agent at request time). See [Costs and Limits](/docs/platform-costs-and-limits).

## Where environments apply

- [Agents](/docs/platform-agents) — sandbox runtime, network egress, and visible tools/knowledge
- [MCP Gateway](/docs/platform-mcp-gateway) — which tools and knowledge the gateway exposes
- [LLM Proxy](/docs/platform-llm-proxy) — cost-limit attribution for inference
- [Knowledge Connectors](/docs/platform-knowledge-connectors) — which environments can use the connector's knowledge
