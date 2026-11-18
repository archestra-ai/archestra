---
title: Upgrade from v1.3 to v1.4
description: Record what v1.4 removes, stop v1.3, and upgrade a Helm deployment to the latest v1.4 release
order: 9
lastUpdated: 2026-11-18
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

v1.4 deletes some v1.3 data instead of converting it: legacy guardrail policies and LLM Proxy cost limits. Write them down before you upgrade, then upgrade with v1.3 stopped. A v1.4 database cannot go back to v1.3 without a backup.

## Before You Upgrade

Record what v1.4 drops, and find what will break, while v1.3 still runs.

1. Back up PostgreSQL and keep your encryption keys. See [Release Channels And Upgrades](/docs/admin/deployment#release-channels-and-upgrades).
2. Write down your tool invocation and trusted data policies. v1.4 deletes them; [Guardrails](/docs/agents/guardrails) replaces them.
3. Write down your LLM Proxy cost limits. v1.4 deletes them.
4. List the apps and tools that call the LLM Proxy with only a provider key. v1.4 rejects them until they use a virtual key.
5. Check your Helm values and environment variables against [Helm Values](#helm-values) and [Environment Variables](#environment-variables).

## Upgrade

Stop every v1.3 pod first. The credential and OAuth client migrations do not support v1.3 and v1.4 pods running side by side. These commands use the release name and namespace from [Helm Deployment](/docs/admin/deployment#helm-deployment).

1. Scale v1.3 to zero:

   ```bash
   kubectl scale deployment archestra-platform archestra-platform-worker \
     --namespace archestra --replicas=0
   ```

2. Run `helm upgrade` with the latest v1.4 release from [GitHub Releases](https://github.com/archestra-ai/archestra/releases). Go straight to the latest patch: later v1.4 releases fix access after the permission conversion. The chart runs the database migrations before it starts the new pods.
3. Wait for the pods to become ready. On the first start, one replica converts v1.3 sharing into permission grants, and `/ready` returns `503` until it finishes. On a large database this takes minutes.
4. Sign in and check **Settings → Service Accounts** and **Settings → OAuth Clients**. Your former team and organization tokens and your OAuth clients appear there.

## After You Upgrade

Rebuild what v1.4 removed:

- **Guardrails:** Guardrails is off after the upgrade, so no tool-call rules apply. Go to **Guardrails**, click **Create my policy**, and add the rules you wrote down. See [Turn On Guardrails](/docs/agents/guardrails#turn-on-guardrails).
- **Cost limits:** recreate each LLM Proxy cost limit as an organization, team, or virtual key limit. See [Set a Budget](/docs/llm-proxy/costs-and-limits#set-a-budget).
- **Provider-key clients:** give each one a [virtual key](/docs/llm-proxy/authentication), or turn on [Allow requests without a virtual key](/docs/llm-proxy/authentication#allow-requests-without-a-virtual-key).
- **Access:** review who can use each agent, gateway, and MCP server. See [Granular Access Control](/docs/admin/access-control#granular-access-control).

## Breaking Changes

Each change below needs an action from you or from the people who use Archestra.

| Change | What to do |
| --- | --- |
| Legacy guardrails are removed: tool invocation and trusted data policies, Dual LLM, policy auto-configure, the **Tool Guardrails** page, and the **Security** settings tab. | Rebuild the rules in [Guardrails](/docs/agents/guardrails). |
| The LLM Proxy rejects a request that carries only a provider key, with `401`. | Use a [virtual key](/docs/llm-proxy/authentication), or allow such requests. |
| LLM Proxy cost limits are removed. | Recreate them as [limits](/docs/llm-proxy/costs-and-limits#set-a-budget). |
| Resource visibility (`scope`, `teams`, `visibility`, `teamIds`) becomes [permission grants](/docs/admin/access-control#granular-access-control). Sending those fields to the API returns `400`. | Update scripts and Terraform that set visibility. Review access after the conversion. |
| Extra LLM proxies are removed. Their history moves to the default proxy. | None. Check that clients call the default proxy. |
| Team and organization MCP gateway tokens become service accounts with the same token value. `/api/tokens` is removed. | None for clients. Manage the tokens under **Settings → Service Accounts**. |
| [`GET /api/agents/options`](/docs/reference/api#/Agents/getAgentOptions) and [`GET /api/projects`](/docs/reference/api#/Projects/getProjects) return pages: `{ data, pagination }`. | Update API clients to read `data` and request the next page. |
| The task MCP tools are renamed to runs: `start_task` is [`start_run`](/docs/reference/archestra-mcp-server#start_run), and `get_task`, `list_tasks`, `steer_task`, `cancel_task`, and `post_task_file` follow the same pattern. | Update prompts and clients that call them. |
| The Code Sandbox runs Python 3.14 instead of 3.12. Existing sandboxes replay their commands on 3.14. | Fix commands that use modules removed in 3.14, such as `cgi`. |
| Agent Runtime turns on when the cluster has the Agent Sandbox controller. | Install the controller. See [Agent Runtime setup](/docs/agents/runtime/setup#cluster-prerequisites). |
| Companion images move to `ghcr.io/archestra-ai`. | Update image mirrors and registry overrides. |

## Helm Values

Most v1.3 values files work unchanged. Update these keys:

| v1.3 value | v1.4 |
| --- | --- |
| `archestra.worker.podAnnotations` | Removed. Set `archestra.podAnnotations`. |
| `archestra.worker.nodeSelector`, `archestra.worker.tolerations` | `null` inherits the top-level `archestra.*` value. `{}` or `[]` clears it. |
| `archestra.renderer.*` | Removed with app recordings. Delete the block. |
| `archestra.orchestrator.mcpIdleHibernationEnabled` | Removed. Follows [`ARCHESTRA_BETA`](/docs/reference/configuration#ARCHESTRA_BETA). |
| `archestra.terminationGracePeriodSeconds` | Defaults to `null`, derived from the shutdown settings. Remove a pinned value unless you need it. See [Release Channels And Upgrades](/docs/admin/deployment#release-channels-and-upgrades). |

## Environment Variables

Remove these variables, or move them to their replacement:

| v1.3 variable | v1.4 |
| --- | --- |
| `ARCHESTRA_AGENT_RUNTIME_ENABLED` | Removed. Agent Runtime detects the controller. |
| `ARCHESTRA_AGENT_RUNTIME_BASE_IMAGE` | [`ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY) and [`ARCHESTRA_AGENT_RUNTIME_IMAGE_TAG`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_IMAGE_TAG) |
| `ARCHESTRA_AGENT_RUNTIME_EPHEMERAL_STORAGE_LIMIT` | [`ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_SIZE`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_SIZE) |
| `ARCHESTRA_MCP_SKILLS_ENABLED`, `ARCHESTRA_PLUGINS_ENABLED`, `ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_ENABLED` | Removed. These follow [`ARCHESTRA_BETA`](/docs/reference/configuration#ARCHESTRA_BETA). |
| `ARCHESTRA_KNOWLEDGE_BASE_AUTO_SYNC_PERMISSIONS_ENABLED` | Removed. Permission sync is always on. |
| `ARCHESTRA_MCP_SERVER_ALERTING_ENABLED`, `ARCHESTRA_APP_RECORDING_RENDERER_URL` | Removed with their features. |
| `ARCHESTRA_LOCKED_CHAT_ESCROW_PUBLIC_KEY` | Renamed to [`ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY`](/docs/reference/configuration#ARCHESTRA_ENCRYPTED_CHAT_ESCROW_PUBLIC_KEY). The old name still works. |

If you deploy without the Helm chart, label the platform API pods `archestra.io/platform-api=true`. Agent Runtime finds them with [`ARCHESTRA_AGENT_RUNTIME_PLATFORM_POD_SELECTOR`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_PLATFORM_POD_SELECTOR).

## Roll Back

To return to v1.3, restore the backup you took before the upgrade, then deploy v1.3. Rolling back the image alone does not work: v1.4 drops tables that v1.3 reads.
