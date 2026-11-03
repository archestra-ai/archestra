---
title: Diagnostics
description: Investigate an installation with the SRE agent and collect a support bundle
order: 7
lastUpdated: 2026-11-03
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

## SRE Agent

Ask the SRE agent why an Archestra pod keeps restarting, and it reads that pod's events and logs, then answers with ranked hypotheses and the evidence for each. It sees only Archestra's own namespace, through a read-only Kubernetes MCP server that the chart runs under a dedicated `-sre` ServiceAccount. That account cannot read Secrets or ConfigMaps or change anything.

The SRE agent and its Kubernetes MCP Registry entry start with **Can use** access for Admin and Platform Admin roles only. People who can manage the SRE agent's permissions can change **Who can use it** on its edit page; this also controls direct access to its Kubernetes tools. The catalog entry has its own policy and can be changed separately. Pod specs can carry other MCP servers' credentials, so review these grants for your deployment. See [Granular Access Control](/docs/admin/access-control#granular-access-control).

The SRE agent remains available in chat, ChatOps, delegation, and project defaults wherever its object grant allows use. Its configuration remains editable by authorized users. As a built-in agent, it cannot be cloned, exported, restored from an older version, or deleted; these actions would replace or remove the installation-managed agent.

1. Find the Kubernetes API server endpoint IPs with `kubectl get endpoints kubernetes -n default`. Use these IPs (with `/32`), not the `kubernetes` Service IP.
2. Turn the agent on in your Helm values, then run `helm upgrade`:

   ```yaml
   archestra:
     sre:
       enabled: true
       apiServerCidrs:
         - 172.16.0.2/32
   ```

3. After the rollout, open **Chat**, pick the **SRE** agent, and ask "Why did a pod restart in the last hour?" If the agent is missing, check **Who can use it** on its edit page. If it has no Kubernetes tools, check the Kubernetes entry in **MCP Registry** for an installation error and confirm your access to that entry.

The MCP server's egress is your organization's [default network policy](/docs/admin/environments) plus `apiServerCidrs`. A change applies when the **Kubernetes** MCP server's pod restarts.

With the [code sandbox](/docs/agents#code-sandbox) on, the agent clones the source of the running Archestra version from GitHub to tie errors to code, so the default policy must allow GitHub.

Setting `enabled: false` deletes the agent, its MCP server, and its environment, including your changes to the agent.

## Collect a Support Bundle

Attach a support bundle when you report a problem: one file with your installation's pods, restarts, events, recent logs, and versions.

The script requires `kubectl`, `helm`, and `jq` with read access to the namespace. Run [`support-bundle.sh`](https://github.com/archestra-ai/archestra/blob/main/platform/scripts/support-bundle.sh) with the release namespace and name (check with `helm list -A`):

```bash
curl -fsSLO https://raw.githubusercontent.com/archestra-ai/archestra/main/platform/scripts/support-bundle.sh
bash support-bundle.sh <namespace> <release>
```

It prints the path of the `.tar.gz` it wrote.

The bundle leaves out Secrets, ConfigMaps, environment values, container arguments, probe headers, and every Helm value except a fixed list of non-secret settings. Logs are copied as written, so read the bundle before you share it.

A step that fails or times out leaves its error in the bundle, and the rest is still collected. To change the 20-second timeout per `kubectl` call, set `KUBECTL_REQUEST_TIMEOUT`.

