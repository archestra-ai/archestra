---
title: "Environments"
category: Administration
description: "Isolate tools, knowledge, skills, subagents, runtimes, and cost limits across deployment environments"
order: 3
lastUpdated: 2026-08-30
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

<!--
This document is the canonical reference for deployment Environments. Include:
- What an environment is and the implicit "Default" environment (null)
- Who can view vs. manage environments (environment:read / create / update / delete), Settings > Environments
- Restricted environments and the per-resource deploy-to-restricted permissions
- Environment isolation: how an environment scopes which tools, knowledge,
  skills, and delegation targets an agent / MCP gateway can use
  (strict matching; Default is a peer, not a wildcard; skills can be
  restricted to several environments or none = everywhere; MCP Apps accept
  Default tools as a shared baseline; built-in servers and built-in skills
  are exempt)
- Network egress policies (namespace + egress policy applied to MCP server pods,
  agent code sandboxes, and Agent Background execution Jobs), the always-on
  Public internet floor, provider support matrix, and domain presets
- How environments scope per-environment cost limits
- Link out to: agents, mcp gateway, knowledge connectors, costs & limits
-->

An environment is an organization-level deployment target — for example `sandbox`, `staging`, or `production`. Environments partition an organization's resources so that what an agent or gateway can reach is scoped to where it runs: a "dev" gateway cannot use "prod" tools or knowledge, and spend can be capped per environment. Each environment carries a name, an optional Kubernetes namespace, and an optional network egress policy.

Viewing environments requires the `environment:read` permission — every predefined role includes it. Creating, editing, and deleting environments require `environment:create`, `environment:update`, and `environment:delete`. Environments are managed in **Settings → Environments**.

## The Default environment

Every organization has an implicit **Default** environment. Any resource whose environment is unset belongs to Default. Default is a real peer environment, not a wildcard: a resource in Default is not visible to a resource assigned to a named environment, and vice versa. [MCP Apps](/docs/platform-apps) are the one exception — an app accepts Default-environment tools as a shared baseline. Because everything starts in Default, isolation only changes behavior once you explicitly assign a non-default environment. Default can define a Kubernetes namespace and network egress policy like any other environment.

## Where new resources land

New resources go to Default unless you say otherwise. In **Settings → Environments**, the cog beside "Add environment" opens "Where new resources land", which sets a landing environment per kind of resource: MCP servers, MCP Apps, agents, MCP gateways, and knowledge connectors are each configured on their own. A new MCP server can start in `explore` while a new MCP App starts in `launch`. The cog appears once you have at least one environment besides Default.

The setting only applies when nobody picks an environment. Choosing one on the create form's **Configuration** step always wins, including choosing Default. Changing the setting never moves resources that already exist.

A creator who lacks the `deploy-to-restricted` permission for a restricted landing environment gets Default instead, so the setting never blocks a resource they are otherwise allowed to create.

### Use case

Acme wants engineers to try MCP servers without touching production traffic. An admin points new MCP servers at `explore`, which allows egress only to package registries. Everything an engineer installs starts there. Once a server is ready, an admin reassigns it to `production`.

## Restricted environments

An environment can be marked **restricted**. Assigning a resource to a restricted environment requires the `deploy-to-restricted` permission on that resource — `mcpRegistry:deploy-to-restricted` for MCP servers, for example. Each resource is gated on its own permission, so an organization can allow agents and apps in a restricted environment while still limiting who deploys MCP servers there. Unrestricted environments and Default stay open to anyone who can create the resource. The Default environment can be restricted the same way via organization settings.

## Trusted image registries

An environment can list the image registries it trusts. If an MCP server's image is not from a trusted registry, it is not deployed until an admin approves it. With no list set, any image is allowed.

![MCP server held pending admin approval of its image](/docs/automated_screenshots/platform-environments_image-pending-approval.webp)

### Use case

Acme wants engineers to install MCP servers only from its own image registry. An admin sets the environment's trusted list to `registry.acme.com`. Servers built from `registry.acme.com/slack-mcp` or `registry.acme.com/jira-mcp` deploy automatically, but one from `ghcr.io/community/notion-mcp` waits for admin approval.

![Trusted image registries editor in Settings > Environments](/docs/automated_screenshots/platform-environments_trusted-image-registries.webp)

## Tool, knowledge, skill, and subagent isolation

An agent or MCP gateway assigned to **Production** can only see and use:

- MCP tools whose server (catalog item) is in Production
- MCP servers in the [private registry](/docs/platform-private-registry) that are in Production, including their deployments
- knowledge connectors in Production
- [Agent Skills](/docs/platform-agent-skills#environments) restricted to Production, or restricted to no environment at all
- [subagent delegation targets](/docs/platform-agents#delegation) in Production

Matching is strict for tools, knowledge, and subagents: a Production resource matches only other Production resources, a Dev resource matches only Dev, and Default matches only Default. Skills differ — a skill can be restricted to any number of environments, and a skill with none is available everywhere. [MCP Apps](/docs/platform-apps) differ too: an app accepts Default-environment tools alongside its own environment's, so Default acts as a shared baseline for apps. Built-in servers (the Archestra control-plane server and Playwright) and built-in skills are exempt and always available. The [Advisor](/docs/platform-built-in-subagents#advisor) is the one delegation exception — the organization has a single Advisor, and agents in every environment can consult it. Its spend counts against the consulting agent's environment.

An agent creates in its own environment. When an agent adds an MCP server to the registry, or builds an [app](/docs/platform-apps), that resource lands in the agent's environment — so the agent can still see it afterwards. A new app created from the Apps page follows the same rule: it lands in the environment of the chat agent that opens with it. An agent with no environment of its own uses the landing environment configured for that kind of resource. You can name a different environment explicitly when adding a server.

An agent also configures only its own environment. It can assign and remove tools on agents and gateways in that environment, and nowhere else.

This applies to both explicitly assigned resources and the implicit **Auto** access modes — in both cases cross-environment resources are filtered out before they are listed or executed. In the agent's explicit assignment pickers, resources from another environment are shown disabled. Skill filtering covers `list_skills`, `load_skill`, and chat slash commands; a [skill that runs in a subagent](/docs/platform-agent-skills#running-a-skill-in-a-subagent) additionally requires its designated agent in the same environment.

## Network egress policies

An environment can define a Kubernetes **namespace** and a **network egress policy**. Self-hosted MCP server pods, agent [code sandboxes](/docs/platform-code-sandbox), and Agent [Background execution Jobs](/docs/platform-agent-background-execution#environments-and-network-egress) run in that namespace and inherit the policy, so their outbound network reach is contained. A policy sets one of three egress modes. **Block all** (`off`) denies all egress. **Allowlist** (`restricted`) permits only selected IP/CIDR ranges and domains. **Public internet** (`unrestricted`) permits public egress and any additional CIDRs you list. Pods in your cluster still get a [fixed floor](#the-public-internet-floor) of blocked reserved ranges outside those explicit exceptions. Domain presets and custom domains require a supported FQDN policy provider; Kubernetes `NetworkPolicy` alone only enforces IP/CIDR rules.

When a workload runs in an environment, Archestra uses the environment's network policy, then the organization default network policy, then the built-in Public internet policy (`unrestricted`).

| Workload requirement                  | Egress mode                                    |
| ------------------------------------- | ---------------------------------------------- |
| No outbound access                    | **Block all**                                  |
| Selected internal or public endpoints | **Allowlist**, with those domains or CIDRs     |
| Public internet without private ranges | **Public internet**                            |
| Public internet plus a private range   | **Public internet**, with an additional CIDR   |

An environment applies one policy to all of its workloads. Use separate environments when MCP servers need different policies. The environments can share a Kubernetes namespace, but the usual [environment isolation](#tool-knowledge-skill-and-subagent-isolation) still applies.

How a policy applies depends on the workload. A **self-hosted MCP server**, agent code sandbox, or Agent Background execution runs in your cluster, so the policy is enforced continuously at the network layer. Archestra selects the cluster's supported policy type before creating the workload. A workload that needs broad outbound access (for example one that visits arbitrary sites) fails under a restrictive policy unless its destinations are allowlisted.

A **remote MCP server** runs outside Archestra and is reached over HTTP, so the policy cannot constrain what the server itself reaches downstream. What Archestra enforces is its own outbound connection to the server: the server's URL host is checked against the environment's policy both when the catalog entry is created or edited (the error is surfaced in the form) and at runtime on every connection. A server whose host the policy forbids is blocked — including one added before the policy was tightened — and its tool calls return an error to the client.

| Cluster provider        | IP/CIDR rules                                                         | Domain rules                                                                               |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| EKS Auto Mode           | Kubernetes `NetworkPolicy` when network policy enforcement is enabled | AWS `ApplicationNetworkPolicy` when the EKS Auto Mode Network Policy Controller is enabled |
| EKS with AWS VPC CNI    | Kubernetes `NetworkPolicy` when network policy enforcement is enabled | Not supported outside EKS Auto Mode DNS-based policies                                     |
| AKS                     | Kubernetes `NetworkPolicy` when network policy enforcement is enabled | Cilium `CiliumNetworkPolicy` when the cluster exposes the Cilium CRD                       |
| GKE                     | Kubernetes `NetworkPolicy` when network policy enforcement is enabled | GKE `FQDNNetworkPolicy` when GKE Dataplane V2 and FQDN network policy are enabled          |
| Cilium-enabled clusters | Kubernetes `NetworkPolicy` or Cilium policy                           | Cilium `CiliumNetworkPolicy`                                                               |

See Kubernetes [NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/), Cilium [DNS policy](https://docs.cilium.io/en/latest/security/dns/), GKE [FQDN network policy](https://cloud.google.com/kubernetes-engine/docs/how-to/fqdn-network-policies), and EKS Auto Mode [network policy](https://docs.aws.amazon.com/eks/latest/userguide/auto-net-pol.html) docs for provider details. AWS DNS-based rules apply only to workloads running on EKS Auto Mode-launched EC2 instances.

On EKS Auto Mode, `ApplicationNetworkPolicy` only supports IP and domain egress peers, so Archestra automatically adds a DNS bootstrap rule allowing port 53 to the cluster DNS service IP (recorded in the `archestra.io/network-policy-cluster-dns` annotation).

### The Public Internet Floor

Public internet mode blocks a fixed set of destinations for pods in your cluster:

- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` — private ranges, where your other pods, services, and nodes live
- `169.254.0.0/16` — link-local, including the AWS, GCP, and Azure metadata endpoints
- `168.63.129.16/32` — Azure platform metadata, a public address outside the ranges above
- `100.64.0.0/10` — carrier-grade NAT
- `127.0.0.0/8` and `0.0.0.0/8` — loopback
- `::1/128`, `fc00::/7`, `fe80::/10`, `64:ff9b::/96` — the IPv6 equivalents

The floor stops a server that fetches a URL from reaching your internal network or a cloud metadata endpoint. DNS to the cluster resolver stays allowed.

To retain public internet access and reach one private range, add that range under **Additional allowed CIDRs**. The explicit CIDR becomes an exception to the floor. Other private and reserved ranges stay blocked. For example, adding `10.20.0.0/16` does not open the rest of `10.0.0.0/8`.

Use **Allowlist** instead when the workload should reach only selected destinations. CIDRs in either mode are explicit network-policy allow rules.

### Domain Presets

#### Common Dependencies

```text
alpinelinux.org
archlinux.org
bitbucket.org
centos.org
crates.io
debian.org
docker.com
docker.io
*.docker.io
fedoraproject.org
files.pythonhosted.org
gcr.io
ghcr.io
github.com
*.github.com
githubusercontent.com
*.githubusercontent.com
gitlab.com
golang.org
goproxy.io
gradle.org
hex.pm
maven.org
mcr.microsoft.com
nodejs.org
npmjs.com
npmjs.org
nuget.org
packagecloud.io
packages.microsoft.com
packagist.org
pkg.go.dev
production.cloudflare.docker.com
pub.dev
pypa.io
pypi.org
pypi.python.org
raw.githubusercontent.com
objects.githubusercontent.com
quay.io
registry-1.docker.io
registry.npmjs.org
ruby-lang.org
rubygems.org
rustup.rs
ubuntu.com
yarnpkg.com
```

#### Package Managers

```text
crates.io
files.pythonhosted.org
gcr.io
ghcr.io
golang.org
goproxy.io
gradle.org
hex.pm
maven.org
mcr.microsoft.com
npmjs.com
npmjs.org
nuget.org
packagist.org
pkg.go.dev
registry-1.docker.io
registry.npmjs.org
rubygems.org
rustup.rs
pub.dev
pypi.org
pypi.python.org
pythonhosted.org
quay.io
docker.io
*.docker.io
production.cloudflare.docker.com
yarnpkg.com
```

## Cost limits

Cost limits and per-user default limits can be scoped to an environment. A limit on **Production** only counts usage attributed to Production (an interaction's environment is snapshotted from its agent at request time). See [Costs and Limits](/docs/platform-costs-and-limits).

## Where environments apply

- [Agents](/docs/platform-agents) — sandbox runtime, network egress, and visible tools/knowledge
- [MCP Gateway](/docs/platform-mcp-gateway) — which tools and knowledge the gateway exposes
- [Agent Skills](/docs/platform-agent-skills#environments) — which skills an agent can list, load, or run
- [Knowledge Connectors](/docs/platform-knowledge) — which environments can use the connector's knowledge
- [Private Registry](/docs/platform-private-registry) — assigning MCP catalog entries to environments
