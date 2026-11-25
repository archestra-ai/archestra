---
title: Environments
description: Separate staging and production resources and workload networks
order: 3
lastUpdated: 2026-11-25
---

<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

Keep a staging agent away from production tools and knowledge, and give its workloads a different network policy. Environments separate resource sets inside one Archestra organization.

<span id="cluster-support"></span>

<span id="cost-limits"></span>

<span id="domain-presets"></span>

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

**Can use** covers agents, MCP gateways, MCP servers, skills, apps, and knowledge connectors. To let someone deploy only some of these, such as agents and apps but not MCP servers, clear the other kinds under **Can use**.

- Default stays open to anyone who can create the resource.
- Roles that could deploy only some kinds into restricted environments before the upgrade to 1.4 keep those limits.

## Trusted Image Registries

List trusted registries on an environment to require approval for MCP server images from other sources. An empty list allows any image.

## Tool, Knowledge, Skill, and Subagent Isolation

An agent or gateway sees resources from its own environment, with two shared-resource exceptions.

| Resource | Available to an agent or gateway |
| --- | --- |
| MCP tools and registry entries | Only servers in the same environment. Two environments can each hold a server of the same name, and each agent's calls reach the server in its own environment. |
| Knowledge connectors | Only connectors in the same environment. |
| Subagents | Only delegation targets in the same environment. |
| [Skills](/docs/agents/skills) | Skills restricted to that environment, or to no environments. A skill naming a subagent also needs that agent in the same environment. |
| Built-in servers and skills | Always available, including Archestra's own tools and Playwright. |

These rules apply to both manual assignments and execution. An app created from a chat uses its agent's environment.

## Network Egress Policies

Limit what self-hosted MCP servers, [code sandboxes](/docs/agents#code-sandbox), and [coding agent workspaces](/docs/agents/runtime#environments-and-network-egress) can connect to. For example, let staging reach the public internet, and let production reach only your own APIs.

To set a policy, go to **Settings → Environments**, edit an environment, and open the **Network Egress Policy** tab. Under **Egress**, pick one:

| Egress | What they can reach |
| --- | --- |
| **Block all** | Nothing. |
| **Allowlist** | Only the domains and CIDRs that you list. |
| **Public internet** | The public internet, but not your internal network. To add one internal service, enter its range under **Additional allowed CIDRs**. |

An environment without a policy uses the policy of the default environment. If that has none, the built-in default policy applies.

Your cluster must [enforce network policies](/docs/admin/deployment/networking#enforce-workload-egress). Creating a policy alone does not prevent MCP servers, agents, and code sandboxes from reaching an address that the policy blocks.

### Built-in Default Policy

<span id="the-public-internet-floor"></span>

By default, Archestra applies a built-in network policy. MCP servers, agents, and code sandboxes can reach the public internet, but not your internal network. For example, an MCP server can call `api.github.com`, but it can't connect to your database or get the cloud credentials of the machine it runs on.

It blocks the addresses below:

| Blocked | Examples | Ranges |
| --- | --- | --- |
| Internal networks | Your databases, other services in the cluster, company systems on the same network | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7` |
| Cloud metadata service | The address on every AWS, Google Cloud, or Azure machine that hands out the machine's cloud credentials | `169.254.0.0/16`, `168.63.129.16/32`, `fe80::/10` |
| Loopback and reserved ranges | `localhost` | `127.0.0.0/8`, `0.0.0.0/8`, `::1/128`, `64:ff9b::/96` |

To add an allowed address, change the environment's policy to **Public internet** and add the service's range under **Additional allowed CIDRs**.

### Give One Agent Its Own Policy

Lock one agent down, or open it up, without moving it to another environment. Edit the agent, open the **Advanced** step, and under **Network egress** set **Policy** to **Custom for this agent**.

- The agent's policy replaces its environment's for its code sandbox and its [Agent Runtime](/docs/agents/runtime#environments-and-network-egress) workspaces. Its MCP servers keep the environment's policy.
- Setting or clearing it takes [`environment:update`](/docs/reference/permissions#environment:update), because it overrides an environment policy.
- Choose **Inherit from environment** to go back to the environment's policy.

Remote MCP servers run elsewhere. Archestra checks its connection to their URL host when the entry is saved and on every connection, but cannot constrain what the remote server reaches downstream. A tightened policy can therefore block calls to an existing remote server.

Your cluster must [support and enforce the selected rules](/docs/admin/deployment/networking#enforce-workload-egress). Start an allowlist with **Common Dependencies** or **Package Managers**, then add your APIs and private registries.

Set [cost limits](/docs/llm-proxy/cost-controls) per environment when staging and production need separate budgets.
