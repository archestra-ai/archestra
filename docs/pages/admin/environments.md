---
title: Environments
description: Separate staging and production resources and workload networks
order: 3
lastUpdated: 2026-10-22
---

Keep a staging agent away from production tools and knowledge, and give its workloads a different network policy. Environments separate resource sets inside one Archestra organization.

<span id="cluster-support"></span>

<span id="cost-limits"></span>

<span id="domain-presets"></span>

<span id="the-public-internet-floor"></span>

## Creating an Environment

Create an environment before assigning resources to it; existing resources stay where they are.

1. With [`environment:create`](/docs/reference/permissions#environment:create), open **Settings → Environments** and click **Add environment**.
2. Enter a name and, for Kubernetes workloads, a namespace. Select a network egress policy when needed.
3. Save and confirm the environment appears in the list.
4. On a new agent or MCP server's **Configuration** step, select it. Confirm the saved resource shows the intended environment.

![Deployment environments in Settings](/docs/automated_screenshots/platform-environments_overview.webp)

## The Default Environment

An unset environment means **Default**, a peer of named environments rather than access to all of them. Default can have its own namespace and network policy.

Tools and knowledge in Default do not automatically become available to production agents. [MCP Apps](/docs/chat/apps) are the exception: they accept Default-environment tools alongside their own environment's tools.

## Where New Resources Land

Choose a landing environment to stop new resources accumulating in Default.

1. Add at least one named environment, then open the cog beside **Add environment**.
2. In **Where new resources land**, choose an environment separately for MCP servers, apps, agents, gateways, and knowledge connectors.
3. Save, then check the environment on the next resource you create.

An explicit selection on the create form wins, including Default. If the creator cannot deploy into the landing environment, creation falls back to Default. Changing this setting never moves existing resources.

## Deploy Permissions

Restrict who can deploy into production through the environment's [permissions](/docs/admin/access-control#granular-access-control).

1. Open the environment's permissions.
2. Remove the grant to **Everyone in the organization** that new environments start with.
3. Grant **Can use** to the people or teams allowed to deploy there.

The grant covers agents, MCP servers, apps, gateways, and knowledge connectors. Default stays open to anyone who can create the resource.

## Trusted Image Registries

List trusted registries on an environment to require approval for MCP server images from other sources. An empty list allows any image.

## Tool, Knowledge, Skill, and Subagent Isolation

An agent or gateway sees resources from its own environment, with two shared-resource exceptions.

| Resource | Available to an agent or gateway |
| --- | --- |
| MCP tools and registry entries | Only servers in the same environment. |
| Knowledge connectors | Only connectors in the same environment. |
| Subagents | Only delegation targets in the same environment. |
| [Skills](/docs/agents/skills) | Skills restricted to that environment, or to no environments. A skill naming a subagent also needs that agent in the same environment. |
| Built-in servers and skills | Always available, including Archestra's own tools and Playwright. |

These rules apply to both manual assignments and execution. An app created from a chat uses its agent's environment.

## Network Egress Policies

Choose what workloads can reach from the environment's namespace. Archestra uses the environment policy, then the organization default, then Public internet.

| Need | Mode |
| --- | --- |
| No outbound access | Block all (`off`). |
| Only selected endpoints | Allowlist (`restricted`), with their domains or CIDRs. |
| Public destinations | Public internet (`unrestricted`), which blocks private and reserved ranges. |
| Public destinations plus a private service | Public internet, with that service's range under **Additional allowed CIDRs**. |

Self-hosted MCP servers, [code sandboxes](/docs/agents#code-sandbox), and [coding agent workspaces](/docs/agents/runtime#environments-and-network-egress) inherit the policy. The cluster must enforce the relevant policy type; creating a policy object alone does not isolate workloads.

Remote MCP servers run elsewhere. Archestra checks its connection to their URL host when the entry is saved and on every connection, but cannot constrain what the remote server reaches downstream. A tightened policy can therefore block calls to an existing remote server.

Your cluster must [support and enforce the selected rules](/docs/admin/deployment/networking#enforce-workload-egress). Start an allowlist with **Common Dependencies** or **Package Managers**, then add your APIs and private registries.

Set [cost limits](/docs/llm-proxy/costs-and-limits) per environment when staging and production need separate budgets.
