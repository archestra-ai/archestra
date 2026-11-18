---
title: Environments
description: Separate staging and production resources and workload networks
order: 3
lastUpdated: 2026-11-17
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

Choose what workloads can reach from the environment's namespace. Archestra uses the agent's own policy, then the environment policy, then the organization default, then Public internet.

| Need | Mode |
| --- | --- |
| No outbound access | Block all (`off`). |
| Only selected endpoints | Allowlist (`restricted`), with their domains or CIDRs. |
| Public destinations | Public internet (`unrestricted`), which blocks private and reserved ranges. |
| Public destinations plus a private service | Public internet, with that service's range under **Additional allowed CIDRs**. |

Self-hosted MCP servers, [code sandboxes](/docs/agents#code-sandbox), and [coding agent workspaces](/docs/agents/runtime#environments-and-network-egress) inherit the policy. The cluster must enforce the relevant policy type; creating a policy object alone does not isolate workloads.

### Give One Agent Its Own Policy

Lock one agent down, or open it up, without moving it to another environment. Edit the agent, open the **Advanced** step, and under **Network egress** set **Policy** to **Custom for this agent**.

- The agent's policy replaces its environment's for its code sandbox and its [Agent Runtime](/docs/agents/runtime#environments-and-network-egress) workspaces. Its MCP servers keep the environment's policy.
- Setting or clearing it takes [`environment:update`](/docs/reference/permissions#environment:update), because it overrides an environment policy.
- Choose **Inherit from environment** to go back to the environment's policy.

Remote MCP servers run elsewhere. Archestra checks its connection to their URL host when the entry is saved and on every connection, but cannot constrain what the remote server reaches downstream. A tightened policy can therefore block calls to an existing remote server.

Your cluster must [support and enforce the selected rules](/docs/admin/deployment/networking#enforce-workload-egress). Start an allowlist with **Common Dependencies** or **Package Managers**, then add your APIs and private registries.

Set [cost limits](/docs/llm-proxy/costs-and-limits) per environment when staging and production need separate budgets.

## Deploy Into Another Cluster

Run an environment's MCP servers, code sandbox, and [coding agent workspaces](/docs/agents/runtime) in a different Kubernetes cluster from the one Archestra runs in. Archestra reaches that cluster in one of two ways:

- **Through the cluster agent.** A small agent runs in that cluster and acts there with its own identity. Archestra calls the agent and stores only the agent's address and token, no credential for the cluster.
- **Through a kubeconfig.** Archestra stores a kubeconfig and calls that cluster's API server. Nothing of Archestra runs there.

### Through the Cluster Agent

1. In the other cluster, install the `archestra-workloads` Helm chart with the agent, in the namespace Archestra deploys into. Set `agent.archestraUrl` to the address at which that cluster reaches Archestra, for Agent Runtime sessions:

   ```bash
   helm install archestra-workloads ./platform/helm/archestra-workloads \
     --namespace team-a \
     --set agent.enabled=true \
     --set agent.archestraUrl=https://archestra.example.com
   ```

2. Make the agent's Service `archestra-cluster-agent-api` reachable from Archestra over HTTPS, for example with `agent.service.type=LoadBalancer` and your provider's internal load balancer annotation. Expose it to Archestra's network only. Archestra refuses a plain `http://` address. Either set `agent.tlsSecretName` to a TLS Secret for the agent, or end TLS at the load balancer or ingress.
3. Run the commands the chart prints. They print the agent's address and its token.
4. With [`environment:create`](/docs/reference/permissions#environment:create), open **Settings → Environments** and click **Add environment**.
5. Under **Kubernetes cluster**, select **Another cluster, through the cluster agent** and enter the agent's address and token. If a private CA signs the agent's certificate, paste it under **CA certificate**.
6. Under **General**, enter a name and the namespace, then click **Test connection** and **Save**.

**Replace token** accepts a new token for the same agent.

### Through a Kubeconfig

1. In the other cluster, install the `archestra-workloads` Helm chart from a checkout of the Archestra repository. List the existing namespaces Archestra may deploy into:

   ```bash
   helm install archestra-workloads ./platform/helm/archestra-workloads \
     --namespace archestra-platform-access --create-namespace \
     --set 'namespaces={team-a}'
   ```

2. Run the commands the chart prints after the install. They print a kubeconfig. Its API server address must be one Archestra can reach.
3. With [`environment:create`](/docs/reference/permissions#environment:create), open **Settings → Environments** and click **Add environment**.
4. Under **Kubernetes cluster**, select **Another cluster, through a kubeconfig** and paste the kubeconfig.
5. Under **General**, enter a name and one of the namespaces you listed for the chart.
6. Back under **Kubernetes cluster**, click **Test connection**, then **Save**. The list shows the cluster under the environment's namespace.

- **The cluster is fixed.** An environment keeps its cluster. **Replace credentials** accepts a new kubeconfig for the same cluster only. For another cluster, create another environment.
- **Coding agent workspaces call back.** They need the [Agent Sandbox controller](/docs/agents/runtime/setup) in that cluster, and the URL at which its pods reach Archestra, set on the environment. The field starts with Archestra's external API address from `ARCHESTRA_API_BASE_URL`; change it if that cluster reaches Archestra at another address. If the URL's host name resolves to a different address inside that cluster, allow that address under **Additional allowed CIDRs**, or write the URL with the IP address.
- **Deleting cleans up first.** Archestra removes its workloads from the cluster before it deletes the environment.

| You see | Do this |
| --- | --- |
| **Test connection** reports that it could not connect | Check that Archestra can reach the API server address. If the credential was rotated, use **Replace credentials**. |
| Saving reports missing permissions in the namespace | Add the namespace to the chart's `namespaces` value and upgrade the release. |
| Deleting reports that the cluster could not be cleaned up | Restore access and click **Try again**, or click **Delete and leave the workloads**. |
