---
title: Diagnostics
description: Investigate an installation with the SRE agent and collect a support bundle
order: 6
lastUpdated: 2026-10-23
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

## SRE Agent

Ask an agent why a pod keeps restarting, and it reads that pod's events and logs in your cluster, then answers with ranked hypotheses and the evidence behind each one. Archestra runs a read-only Kubernetes MCP server for it under its own ServiceAccount, ending in `-sre`, which the chart creates. That account can read pods, pod logs, services, events, and workloads in the Archestra namespace only. It cannot read Secrets or ConfigMaps, and it cannot change anything.

1. Find the Kubernetes API server endpoint IPs: `kubectl get endpoints kubernetes -n default`. Use these IPs, not the `kubernetes` Service IP.
2. Turn the agent on in your Helm values, then run `helm upgrade`. It needs `archestra.orchestrator.kubernetes.mcpServerRbac.create`, which is on by default:

   ```yaml
   archestra:
     sre:
       enabled: true
       apiServerCidrs:
         - 172.16.0.2/32
   ```

3. After the rollout, open **Chat**, pick the **SRE** agent, and ask "Why did a pod restart in the last hour?"

What to know:

- The **SRE** agent and the Kubernetes tools take the [`sre:read`](/docs/reference/permissions) permission, because the server can read the specs of every MCP server pod in the namespace, and their arguments can hold resolved credentials. Only Admin has it by default. Platform Admin, other predefined roles, custom roles, and service accounts do not, unless a role that holds it is granted. Without it, the agent is hidden from lists, chat, and A2A, and the tools are neither listed nor callable, from any agent or the MCP server inspector.
- The agent and the **Kubernetes** catalog item are shared with Admins. To give another role the agent, grant the role `sre:read` and share the agent with it. Other members can still see that the **SRE** environment, with its network policy, and the Kubernetes install exist.
- The MCP server runs in its own **SRE** environment. Its egress is your organization's [default network policy](/docs/admin/environments), or public internet with private ranges blocked when none is set, plus `apiServerCidrs`. So, like other MCP servers, the Kubernetes server can reach the internet; it runs a pinned, read-only image. Without `apiServerCidrs`, it reaches the API server only on clusters that do not enforce egress policies.
- The policy is applied at startup. Changing `apiServerCidrs` or the default policy does not restart the MCP server pod, so connections it already holds stay open until the pod restarts.
- Deleting the agent or its MCP server keeps it deleted across restarts, as long as the deleted item is kept. If it is permanently purged, the next start creates it again.
- Setting `enabled: false` permanently removes the agent, the server, and the environment, including any changes you made to the agent, such as its prompt, tools, and schedules. Turning it back on creates them again from the defaults.
- With the [code sandbox](/docs/agents#code-sandbox) on, the agent also gets its sandbox tools and clones the source of the running version from GitHub to tie errors to code. The sandbox runs under the **SRE** environment's egress, so a default policy that blocks GitHub or the sandbox image registry blocks this too.
- The agent appears once the server's tools are discovered. If it is missing, check the **Kubernetes** server under **MCP Registry** for a startup error.

## Collect a Support Bundle

When you report a problem, a support bundle gives us the pods, restarts, events, recent logs, and versions of your installation in one file. Run [`support-bundle.sh`](https://github.com/archestra-ai/archestra/blob/main/platform/scripts/support-bundle.sh) with the release namespace and name:

```bash
curl -fsSLO https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/scripts/support-bundle.sh
bash support-bundle.sh <namespace> <release>
```

Find the release name with `helm list -n <namespace>`. It needs `kubectl`, `helm`, and `jq` with read access to the namespace, and prints the path of the `.tar.gz` it wrote.

What to know:

- It never collects Secrets, ConfigMaps, container environment values, commands, and arguments, or the header values of HTTP probes and hooks. Each log file is capped at 10 MiB. From the Helm values it keeps only a fixed list of non-secret settings, such as replica counts and resources.
- Logs are copied as written, so look through the bundle before you share it.
- Each `kubectl` call gives up after 20 seconds; set `KUBECTL_REQUEST_TIMEOUT` to change that. A step that fails leaves its error in the bundle, and the rest is still collected.
