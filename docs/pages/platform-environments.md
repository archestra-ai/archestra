---
title: "Environments"
category: Administration
description: "Isolate tools, knowledge, runtimes, and cost limits across deployment environments"
order: 3
lastUpdated: 2026-06-21
---

<!--
Check ../docs_writer_prompt.md before changing this file.

This document is the canonical reference for deployment Environments. Include:
- What an environment is and the implicit "Default" environment (null)
- Who can view vs. manage environments (environment:admin), Settings > Environments
- Restricted environments and the environment:deploy-to-restricted / environment:admin permissions
- Environment isolation: how an environment scopes which tools and knowledge an
  agent / MCP gateway / LLM proxy can use (strict matching; Default is a peer, not
  a wildcard; built-in servers are exempt)
- Network egress policies (namespace + egress policy applied to MCP server pods AND
  agent code sandboxes), provider support matrix, and domain presets
- How environments scope per-environment cost limits
- Link out to: agents, mcp gateway, llm proxy, knowledge connectors, costs & limits
-->

An environment is an organization-level deployment target — for example `sandbox`, `staging`, or `production`. Environments partition an organization's resources so that what an agent or gateway can reach is scoped to where it runs: a "dev" gateway cannot use "prod" tools or knowledge, and spend can be capped per environment. Each environment carries a name, an optional Kubernetes namespace, and an optional network egress policy.

Any member can view the list of environments; creating, editing, and deleting them requires the `environment:admin` permission. Admins manage environments in **Settings → Environments**.

## The Default environment

Every organization has an implicit **Default** environment. Any resource whose environment is unset belongs to Default. Default is a real peer environment, not a wildcard: a resource in Default is not visible to a resource assigned to a named environment, and vice versa. Because everything starts in Default, isolation only changes behavior once you explicitly assign a non-default environment.

## Restricted environments

An environment can be marked **restricted**. Only members with the `environment:deploy-to-restricted` permission (or `environment:admin`, which implies it) can assign resources to a restricted environment. Unrestricted environments and Default stay open to anyone who can create the resource. The Default environment can be restricted the same way via organization settings.

## Tool and knowledge isolation

An agent, MCP gateway, or LLM proxy assigned to **Production** can only see and use:

- MCP tools whose server (catalog item) is in Production
- knowledge connectors in Production

Matching is strict: a Production resource matches only other Production resources, a Dev resource matches only Dev, and Default matches only Default. Built-in servers (the Archestra control-plane server and Playwright) are exempt and always available.

This applies to both explicitly assigned tools/knowledge and the implicit "All tools" access mode — in both cases cross-environment resources are filtered out before they are listed or executed. In the agent dialog's explicit assignment pickers, resources from another environment are shown disabled.

## Network egress policies

An environment can define a Kubernetes **namespace** and a **network egress policy**. Both MCP server pods and agent code sandboxes for that environment run in its namespace and inherit its egress policy, so their outbound network reach is contained. Policies can disable internet egress, allow all egress, or restrict egress to selected IP/CIDR ranges. Domain presets and custom domains require a supported FQDN policy provider; Kubernetes `NetworkPolicy` alone only enforces IP/CIDR rules.

When a workload runs in an environment, Archestra uses the environment's network policy, then the organization default network policy, then the built-in unrestricted policy.

How a policy applies depends on the workload. A **self-hosted MCP server** (or agent code sandbox) runs as a pod in your cluster, so the policy is enforced continuously at the network layer — a workload that needs broad outbound access (for example one that visits arbitrary sites) fails under a restrictive policy unless its destinations are allowlisted.

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
- [LLM Proxy](/docs/platform-llm-proxy) — cost-limit attribution for inference
- [Knowledge Connectors](/docs/platform-knowledge-connectors) — which environments can use the connector's knowledge
- [Private Registry](/docs/platform-private-registry) — assigning MCP catalog entries to environments
