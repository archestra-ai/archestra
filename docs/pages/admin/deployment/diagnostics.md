---
title: Diagnostics
description: Investigate an installation with the SRE agent and collect a support bundle
order: 6
lastUpdated: 2026-10-23
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

## SRE Agent

Ask the SRE agent why an Archestra pod keeps restarting, and it reads that pod's events and logs, then answers with ranked hypotheses and the evidence for each. It sees only Archestra's own namespace, through a read-only Kubernetes MCP server that the chart runs under a dedicated `-sre` ServiceAccount. That account cannot read Secrets or ConfigMaps or change anything.

1. Find the Kubernetes API server endpoint IPs with `kubectl get endpoints kubernetes -n default`. Use these IPs, not the `kubernetes` Service IP.
2. Turn the agent on in your Helm values, then run `helm upgrade`:

   ```yaml
   archestra:
     sre:
       enabled: true
       apiServerCidrs:
         - 172.16.0.2/32
   ```

3. After the rollout, open **Chat**, pick the **SRE** agent, and ask "Why did a pod restart in the last hour?"

Using the agent takes [`sre:read`](/docs/reference/permissions#sre:read), which only Admin holds by default, because the pod specs it reads can carry other MCP servers' credentials. To give the agent to another role, grant that role [`sre:read`](/docs/reference/permissions#sre:read) and share the agent with it.

What to know:

- The MCP server's egress is your organization's [default network policy](/docs/admin/environments) plus `apiServerCidrs`. A change applies when the **Kubernetes** MCP server's pod restarts.
- With the [code sandbox](/docs/agents#code-sandbox) on, the agent clones the source of the running Archestra version from GitHub to tie errors to code, so the default policy must allow GitHub.
- Setting `enabled: false` deletes the agent, its MCP server, and its environment, including your changes to the agent.

If the **SRE** agent is missing from **Chat**, check that your role holds [`sre:read`](/docs/reference/permissions#sre:read), then open the **Kubernetes** server under **MCP Registry** for a startup error.

## Collect a Support Bundle

Attach a support bundle when you report a problem: one file with your installation's pods, restarts, events, recent logs, and versions. Run [`support-bundle.sh`](https://github.com/archestra-ai/archestra/blob/main/platform/scripts/support-bundle.sh) with the release namespace and name, which `helm list -n <namespace>` shows:

```bash
curl -fsSLO https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/scripts/support-bundle.sh
bash support-bundle.sh <namespace> <release>
```

It needs `kubectl`, `helm`, and `jq` with read access to the namespace, and prints the path of the `.tar.gz` it wrote.

What to know:

- It leaves out Secrets, ConfigMaps, environment values, container arguments, probe headers, and every Helm value except a fixed list of non-secret settings.
- Logs are copied as written, so read the bundle before you share it.
- A step that fails or times out leaves its error in the bundle, and the rest is still collected. To change the 20-second timeout per `kubectl` call, set `KUBECTL_REQUEST_TIMEOUT`.
