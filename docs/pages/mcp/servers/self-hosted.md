---
title: Self-Hosted Servers
description: Run MCP server processes in Kubernetes and manage their runtime
order: 4
lastUpdated: 2026-10-14
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Run any MCP server for your whole team, even one built to run on a laptop. Many MCP servers only run as a local process, from npm, PyPI, or a Docker image. Archestra runs them in your Kubernetes cluster and shares them like any remote server.

- It deploys and restarts them. Each install gets its own pod.
- It holds their secrets. Credentials go into the pod, not into anyone's config file.
- It shows their logs. Container logs are on the server's page. Each tool call is in [Logs](/docs/admin/logs).
- It keeps them on your network. The [environment](/docs/admin/environments) limits which hosts a server can reach.

## Set Up the Cluster

With the quickstart or the Helm chart, there is nothing to set up. Go straight to [adding a self-hosted server](/docs/mcp/servers/adding#self-hosted-servers).

- **[Quickstart](/docs/get-started#run-archestra):** Archestra runs its own small Kubernetes cluster inside Docker. That is why the command mounts the Docker socket.
- **[Helm chart](/docs/admin/deployment#install-with-helm):** Archestra runs servers in the cluster it is installed in. The chart creates the service account and permissions it needs.
- **Anything else:** mount a kubeconfig for the target cluster, and set [`ARCHESTRA_ORCHESTRATOR_KUBECONFIG`](/docs/admin/deployment/configuration#ARCHESTRA_ORCHESTRATOR_KUBECONFIG) to its path.

## Change How It Runs

Pull from a private registry, add memory, or mount a volume, from the server's Edit page. Most servers need none of it.

- **Private image:** add an image pull secret, or the registry's credentials.
- **Image pull policy:** `:latest` and untagged images pull on every restart, so a restart runs the newest push. Pinned tags reuse the node's copy, so pods start while the registry is down. Override either per server.
- **Memory, CPU, volumes, or node rules:** edit the **K8s YAML** tab. You need **Full access + deploy** on the server.
- **Who can change it:** the image, command, URL, and authentication take [`mcpRegistry:create`](/docs/reference/permissions#mcpRegistry:create) or **Full access + deploy**. Everyone else edits only the name, icon, description, and labels.
- A credential on each call, such as the caller's [identity provider token](/docs/mcp/authentication/servers#identity-provider-token-exchange): set **Transport** to **streamable-http**. A **stdio** server gets credentials only at start.

<span id="logs-and-recovery"></span>

## Debug a Server

Find the symptom, then open the server in MCP Registry to fix it. Its **Logs**, **Inspector**, and **Shell** tabs show what the pod is doing.

| You see | Do this |
| --- | --- |
| **Failed to start** | Open **Logs**. After a crash, it shows the last run's output. Most often a variable is missing, or the command or arguments are wrong. Fix them under **Edit**. |
| **Starting**, for minutes | The image does not pull, or the cluster has no room. Archestra keeps trying. Check the image name and the pull secret. |
| Wrong or missing tools | Open **Inspector**, click **Refresh Tools**, and call one tool to test it. |
| An old version after you pushed a new image to the same tag | Open **⋯** and click **Restart pods with a fresh image**. Set **Image pull policy** to **Always** so later restarts pull it too. |
| None of these | Open **Shell** for a terminal inside the pod. It takes [`mcpServerInstallation:update`](/docs/reference/permissions#mcpServerInstallation:update). |

<span id="idle-hibernation"></span>

## Idle Hibernation

:::beta:::

Servers nobody uses sleep, so they free their share of the cluster. The next tool call wakes them. It is an [Enterprise feature](/docs/get-started/pricing-model). Turn it on in **Settings → MCP**.

A server sleeps after 30 minutes with no calls. To change that, set [`ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_SECONDS`](/docs/admin/deployment/configuration#ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_SECONDS).

- **The waking call waits** for the pod to start. When the cluster is full, it waits longer. Add an autoscaler or spare capacity.
- To keep a server awake, set **Idle hibernation** to **Never hibernate this server**.
- **Tools stay listed** while a server sleeps. Its resources and prompts do not.
