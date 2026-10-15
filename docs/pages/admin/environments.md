---
title: "Environments"
description: "Isolate tools, knowledge, skills, subagents, runtimes, and cost limits across deployment environments"
order: 3
lastUpdated: 2026-10-15
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Keep a staging agent away from production tools and knowledge, and choose where its workloads run. Environments combine resource isolation, deployment access, network rules, and scoped cost limits.

![Deployment environments in Settings](/docs/automated_screenshots/platform-environments_overview.webp)

## Creating an Environment

Viewing environments requires [`environment:read`](/docs/reference/permissions#environment:read). Creating, editing, and deleting them require the corresponding [`environment:create`](/docs/reference/permissions#environment:create), [`environment:update`](/docs/reference/permissions#environment:update), and [`environment:delete`](/docs/reference/permissions#environment:delete) permissions.

1. Go to **Settings → Environments** and click **Add environment**.
2. Enter a name and choose a Kubernetes namespace when needed. Open **Network Egress Policy** to select outbound network rules.
3. Save the environment and confirm it appears in the list.
4. On a new agent or MCP server's **Configuration** step, select the environment. Confirm its saved configuration shows the intended environment.

## The Default Environment

Resources without a named environment belong to **Default**. Default has its own namespace and network policy; it is not a wildcard for matching resources. Assign resources to a named environment to start separating them.

## Where New Resources Land

Set a landing environment for resources whose creator does not choose one.

1. In **Settings → Environments**, open the cog beside **Add environment**. It appears once a named environment exists.
2. Under **Where new resources land**, choose defaults separately for MCP servers, apps, agents, gateways, and knowledge connectors.
3. Save, then check the environment on the next resource you create.

An explicit choice, including Default, wins over the landing setting. Existing resources stay where they are. If the creator cannot deploy into the landing environment, the new resource uses Default.

## Deploy Permissions

Give a team **Can use** on an environment to let it deploy resources there. Use the environment's **Permissions** control; see [Granular Access Control](/docs/admin/access-control#granular-access-control).

New environments permit the whole organization to deploy. To restrict Production to a release team, add that team with **Can use** and remove the organization grant. The grant covers servers, agents, apps, gateways, and connectors, but does not grant permission to create those resources.

The Default environment is always open to anyone who can create the resource.

## Trusted Image Registries

List trusted image registries to require approval before deploying an MCP image from elsewhere. An empty list permits any registry. Image approval does not replace [deployment permissions](/docs/admin/access-control#actions-and-scopes).

## Tool, Knowledge, Skill, and Subagent Isolation

An agent or gateway in Production uses Production resources, even when its tool mode discovers resources automatically.

| Resource | Matching rule |
| --- | --- |
| MCP servers, tools, knowledge connectors, and subagents | Same environment only; Default matches Default. |
| Skills | Allowed in every environment when unrestricted; otherwise, only the selected environments. |
| MCP Apps' tools | The app's environment plus Default. |
| Built-in Archestra and Playwright servers, and built-in skills | Exempt from environment matching. |

Permissions still apply within the matching environment. Assignment pickers disable resources from elsewhere.

When an agent creates a server or app, it uses the agent's environment. An agent in Default uses the configured landing environment for that resource kind instead. An app created from the Apps page uses the chat agent's environment. A server creation request can explicitly choose a different environment.

An agent can change tool assignments only on agents and gateways in its own environment. A [skill that runs in a subagent](/docs/agents/skills#running-a-skill-in-a-subagent) also needs its designated agent in that environment.

## Network Egress Policies

Choose an egress mode for self-hosted MCP servers, [code sandboxes](/docs/agents#code-sandbox), and [Agent Runtime](/docs/agents/runtime#environments-and-network-egress) workloads.

The cluster must enforce the selected network policy. Kubernetes policy objects alone do not provide isolation. Domain rules need a supported FQDN policy provider; standard NetworkPolicy handles IP/CIDR rules.

| Workload requirement                  | Egress mode                                    |
| ------------------------------------- | ---------------------------------------------- |
| No outbound access                    | **Block all**                                  |
| Selected internal or public endpoints | **Allowlist**, with those domains or CIDRs     |
| Public internet without private ranges | **Public internet**                            |
| Public internet plus a private range   | **Public internet**, with an additional CIDR   |

All workloads in an environment inherit one policy: the environment's choice, then the organization default, then built-in Public internet. Use separate environments for different policies; they can share a namespace without sharing resource access.

- **Workloads in your cluster:** the network layer enforces the policy throughout execution. Allow every destination needed by tools, package managers, and model connections.
- **Remote MCP servers:** Archestra checks its connection to the server's URL host at save time and whenever it connects. A forbidden host produces a form error or a failed tool call. This cannot restrict the remote server's own downstream traffic.

Check your cluster's capabilities before using domain rules:

| Cluster provider        | IP/CIDR rules                                                         | Domain rules                                                                               |
| ----------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| EKS Auto Mode           | Kubernetes `NetworkPolicy` when network policy enforcement is enabled | AWS `ApplicationNetworkPolicy` when the EKS Auto Mode Network Policy Controller is enabled |
| EKS with AWS VPC CNI    | Kubernetes `NetworkPolicy` when network policy enforcement is enabled | Not supported outside EKS Auto Mode DNS-based policies                                     |
| AKS                     | Kubernetes `NetworkPolicy` when network policy enforcement is enabled | Cilium `CiliumNetworkPolicy` when the cluster exposes the Cilium CRD                       |
| GKE                     | Kubernetes `NetworkPolicy` when network policy enforcement is enabled | GKE `FQDNNetworkPolicy` when GKE Dataplane V2 and FQDN network policy are enabled          |
| Cilium-enabled clusters | Kubernetes `NetworkPolicy` or Cilium policy                           | Cilium `CiliumNetworkPolicy`                                                               |

See Kubernetes [NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/), Cilium [DNS policy](https://docs.cilium.io/en/latest/security/dns/), GKE [FQDN network policy](https://cloud.google.com/kubernetes-engine/docs/how-to/fqdn-network-policies), and EKS Auto Mode [network policy](https://docs.aws.amazon.com/eks/latest/userguide/auto-net-pol.html) docs for provider details. AWS DNS-based rules apply only to workloads running on EKS Auto Mode-launched EC2 instances.

Archestra preserves access to the cluster DNS resolver so allowed destinations can resolve.

### The Public Internet Floor

Public internet blocks private and reserved destinations unless an explicit allowed CIDR makes an exception:

- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` — private ranges, where your other pods, services, and nodes live
- `169.254.0.0/16` — link-local, including the AWS, GCP, and Azure metadata endpoints
- `168.63.129.16/32` — Azure platform services, a public address outside the ranges above
- `100.64.0.0/10` — carrier-grade NAT
- `127.0.0.0/8` — loopback; `0.0.0.0/8` — this-network addresses
- `::1/128`, `fc00::/7`, `fe80::/10` — IPv6 loopback, unique-local, and link-local; `64:ff9b::/96` — the well-known NAT64 prefix

These rules keep a server fetching a public URL from reaching internal services or cloud metadata.

To retain public internet access and reach one private range, add that range under **Additional allowed CIDRs**. The explicit CIDR becomes an exception to the floor. Other private and reserved ranges stay blocked. For example, adding `10.20.0.0/16` does not open the rest of `10.0.0.0/8`.

Use **Allowlist** instead when the workload should reach only selected destinations. CIDRs in either mode are explicit network-policy allow rules.

### Domain Presets

The editor offers **Common Dependencies** and **Package Managers** presets. Review the selected domains in the editor and add any private registries or application APIs your workloads need. Domain rules require a supported FQDN policy provider.

## Cost Limits

Scope a cost limit to Production to count only usage attributed to that environment. Attribution uses the agent's environment when the request starts. See [Costs and Limits](/docs/llm-proxy/costs-and-limits).
