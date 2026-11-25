---
title: Upgrade from v1.3 to v1.4
description: What v1.4 changes for your deployment, what it deletes, and the exact steps to upgrade from v1.3 with Helm or Docker
order: 9
lastUpdated: 2026-11-18
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Upgrading to v1.4 takes Archestra offline while the database migrates, and deletes some v1.3 settings for good. Record them, take a backup, then follow the steps for your install. The backup is your only way back to v1.3.

## What Changes for Your Deployment

Each change below needs something from you. Handle the deleted data while v1.3 still runs.

### Deleted in v1.4

v1.4 deletes these instead of converting them. Record them before you upgrade, and recreate them after.

- **Guardrail policies.** The Tool Call Policies and Tool Result Policies on the v1.3 **Guardrails** page are deleted. The new [Guardrails](/docs/agents/guardrails) starts off, so no tool-call rules apply until you go to **Guardrails**, click **Create my policy**, and rebuild them.
- **LLM Proxy cost limits.** Cost limits applied to an LLM Proxy are deleted. Organization, team, user, agent, and virtual key limits are kept. Recreate the deleted ones as [organization limits](/docs/llm-proxy/costs-and-limits#set-a-budget).
- **Custom role permissions.** Custom roles lose their per-area settings, agent trigger, site notification, secret, and scheduled task permissions. Note each role under **Settings → Roles**, then grant [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update), or Projects actions for schedules, where a role needs them.

### Clients That Stop Working

- **Provider-key-only LLM requests** get `401`. Give each client an [Archestra credential](/docs/llm-proxy/authentication), such as a virtual key, or turn on [Allow requests without a virtual key](/docs/llm-proxy/authentication#allow-requests-without-a-virtual-key).
- **Extra LLM Proxies** are removed: only your default proxy remains. Requests to another proxy's ID get `404`, so point those clients at the default proxy.
- **Sharing fields in the API** are rejected with `400`: `scope`, `teams`, `users`, `visibility`, `teamIds`, and `restricted`. Sharing is now [permission grants](/docs/admin/access-control#granular-access-control). Update scripts that set these fields, and review who can use each agent, gateway, and MCP server.
- **Team and organization gateway tokens** become service accounts with the same token value. The organization token reaches only gateways shared with the whole organization. Check them under **Settings → Service Accounts**, and grant access where a client lost it.
- **Terraform provider 2.x** does not work with v1.4, and 3.x does not work with v1.3. After the upgrade, move to 3.x with its [migration guide](https://github.com/archestra-ai/terraform-provider-archestra/blob/main/MIGRATION-v3.md).
- **API clients** of [`GET /api/agents/options`](/docs/reference/api#/Agents/getAgentOptions) and [`GET /api/projects`](/docs/reference/api#/Projects/getProjects) now get pages: `{ data, pagination }`. `/api/tokens` is removed.
- **Task MCP tools** are renamed: `start_task` is [`start_run`](/docs/reference/archestra-mcp-server#start_run), and the other `*_task` tools follow. Update prompts and clients that call them.

### Behavior Changes

- **OAuth token rate limit.** The token endpoint allows 100 requests per minute per client IP. Behind an ingress, every client shares one IP: set [`ARCHESTRA_TRUST_PROXY`](/docs/reference/configuration#ARCHESTRA_TRUST_PROXY) to your load balancer's addresses.
- **MCP server image updates.** Servers on a `:latest` or untagged image restart onto the new build when the tag moves, checked every 15 minutes. Pin image tags, or set [`ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_UPDATE_CHECK_INTERVAL_MINUTES=0`](/docs/reference/configuration#ARCHESTRA_ORCHESTRATOR_MCP_IMAGE_UPDATE_CHECK_INTERVAL_MINUTES).
- **Manual tool mode.** Agents and MCP gateways in **Manual** mode get [Progressive tool loading](/docs/mcp/gateway): clients see [`search_tools`](/docs/reference/archestra-mcp-server#search_tools) and [`run_tool`](/docs/reference/archestra-mcp-server#run_tool) instead of the full list. Turn it off where a client needs every tool up front.
- **Code Sandbox Python.** Sandboxes run Python 3.14, up from 3.12. Fix commands that use modules removed since 3.12, such as `cgi`, or packages without 3.14 wheels.
- **Agent Runtime.** It needs the Agent Sandbox controller in your cluster. If you use Agent Runtime, see [Cluster Prerequisites](/docs/agents/runtime/setup#cluster-prerequisites).
- **Image registry.** Companion and agent images publish to `ghcr.io/archestra-ai`; the platform image stays at `archestra/platform`. Update image mirrors and registry overrides.

## Before You Upgrade

1. Record everything under [Deleted in v1.4](#deleted-in-v14).
2. Pick the latest v1.4 release from [GitHub Releases](https://github.com/archestra-ai/archestra/releases). Use v1.4.33 or later: it fixes access that earlier v1.4 releases got wrong after the conversion.
3. With Helm, update `values.yaml`. See [Helm Values](#helm-values).
4. Update your environment variables. See [Environment Variables](#environment-variables).
5. With Argo CD or Flux, pause auto-sync. It would restart the v1.3 pods you stop during the upgrade.
6. Plan downtime. Nothing serves requests from the moment you stop v1.3 until v1.4 reports ready.

## Upgrade With Helm

These commands assume the release `archestra-platform` in the namespace `archestra`, as in [Helm Deployment](/docs/admin/deployment#helm-deployment), with the bundled PostgreSQL.

1. Note your web and worker replica counts, then stop v1.3 and wait until its pods are gone:

   ```bash
   kubectl get deployment archestra-platform archestra-platform-worker -n archestra
   kubectl scale deployment archestra-platform archestra-platform-worker -n archestra --replicas=0
   kubectl wait pod -n archestra --for=delete --timeout=5m \
     -l 'app.kubernetes.io/instance=archestra-platform,app.kubernetes.io/component in (web,worker)'
   ```

   v1.3 and v1.4 must not run against the database at the same time.

2. Back up the database while nothing writes to it. With an external database, use your own backup instead.

   ```bash
   PGPASS=$(kubectl get secret archestra-platform-postgresql -n archestra -o jsonpath='{.data.password}' | base64 -d)
   kubectl exec -n archestra archestra-platform-postgresql-0 -- \
     env PGPASSWORD="$PGPASS" pg_dump -U archestra -d archestra_dev -Fc > archestra-v1.3.dump
   ```

3. Upgrade the chart. Helm runs the database migrations before it starts v1.4.

   ```bash
   export ARCHESTRA_VERSION="1.4.39" # x-release-please-version
   helm upgrade archestra-platform \
     oci://ghcr.io/archestra-ai/helm-charts/archestra-platform \
     --version "$ARCHESTRA_VERSION" --namespace archestra \
     --values values.yaml --timeout 30m
   ```

   Do not add `--atomic`, `--rollback-on-failure`, or `--reuse-values`. The first two put v1.3 back on a migrated database. The last keeps the v1.3 image tag.

4. Start v1.4 with the replica counts you noted (`1` below), and wait for it:

   ```bash
   kubectl scale deployment archestra-platform archestra-platform-worker -n archestra --replicas=1
   kubectl rollout status deployment archestra-platform -n archestra --timeout=30m
   kubectl rollout status deployment archestra-platform-worker -n archestra --timeout=15m
   ```

   With autoscaling on, scale the web Deployment to your `minReplicas`: the autoscaler does not start it from zero. On its first start, v1.4 converts v1.3 sharing into permission grants and reports not ready until it finishes. The worker starts after the web pod is ready.

5. Sign in, then recreate what you recorded under [Deleted in v1.4](#deleted-in-v14).

If a migration fails, Helm deletes the migration Job and its logs. To keep them, follow the logs from a second terminal during the upgrade: `kubectl logs -n archestra -f job/archestra-platform-migrate`. Never start v1.3 against the migrated database: [roll back](#roll-back) instead.

## Upgrade With Docker

The v1.4 container migrates the database when it starts. It also rebuilds its embedded Kubernetes cluster, so your MCP servers redeploy and lose files stored inside them.

1. Find the container with `docker ps`, stop it, and back up both volumes:

   ```bash
   docker stop --time 120 <container>
   for volume in archestra-postgres-data archestra-app-data; do
     docker run --rm -v "$volume":/data -v "$PWD":/backup alpine \
       tar czf "/backup/$volume-v1.3.tgz" -C /data .
   done
   docker rm <container>
   ```

2. Start v1.4 with the same volumes. Pin the version: `latest` can be a release candidate.

   ```bash
   docker run \
     -p 127.0.0.1:9000:9000 -p 127.0.0.1:3000:3000 \
     -e ARCHESTRA_QUICKSTART=true \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -v archestra-postgres-data:/var/lib/postgresql/data \
     -v archestra-app-data:/app/data \
     archestra/platform:1.4.39 # x-release-please-version
   ```

3. Open <http://localhost:3000>, sign in, then recreate what you recorded under [Deleted in v1.4](#deleted-in-v14).

## Helm Values

A v1.3 values file renders with the v1.4 chart, but these keys need changes:

- `archestra.imageTag`: delete it, or set it to the v1.4 version. A values file from `helm show values` pins `1.3.81`, which keeps v1.3 running under the v1.4 chart.
- `archestra.worker.nodeSelector` and `archestra.worker.tolerations`: delete them if they are `{}` or `[]`. In v1.4 an empty value clears the shared `archestra.*` value instead of inheriting it.
- `archestra.terminationGracePeriodSeconds`: delete it to derive it from the shutdown settings. A value below that budget, 120 seconds by default, fails the upgrade.
- `archestra.worker.podAnnotations`: removed. Use `archestra.podAnnotations`.
- `archestra.renderer.*` and `archestra.orchestrator.mcpIdleHibernationEnabled`: removed. Delete them.

If you manage the Role yourself (`rbac.create: false`), add the rules the v1.4 chart adds for events, persistent volume claims, and Agent Sandbox resources.

## Environment Variables

Remove these v1.3 variables, or move them to their replacement:

- `ARCHESTRA_AGENT_RUNTIME_ENABLED`: removed. Agent Runtime turns on when the cluster has the Agent Sandbox controller.
- `ARCHESTRA_AGENT_RUNTIME_BASE_IMAGE`: use [`ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_IMAGE_REGISTRY) and [`ARCHESTRA_AGENT_RUNTIME_IMAGE_TAG`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_IMAGE_TAG).
- `ARCHESTRA_AGENT_RUNTIME_EPHEMERAL_STORAGE_LIMIT`: workspaces are persistent volumes. Size them with [`ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_SIZE`](/docs/reference/configuration#ARCHESTRA_AGENT_RUNTIME_WORKSPACE_STORAGE_SIZE).
- `ARCHESTRA_PLUGINS_ENABLED`, `ARCHESTRA_MCP_SERVER_ALERTING_ENABLED`, and `ARCHESTRA_KNOWLEDGE_BASE_AUTO_SYNC_PERMISSIONS_ENABLED`: removed. Plugins, MCP server alerts, and connector permission sync are always available, so setting `false` no longer turns them off.
- `ARCHESTRA_MCP_SKILLS_ENABLED` and `ARCHESTRA_ORCHESTRATOR_MCP_IDLE_HIBERNATION_ENABLED`: removed. These follow [`ARCHESTRA_BETA`](/docs/reference/configuration#ARCHESTRA_BETA).
- `ARCHESTRA_APP_RECORDING_RENDERER_URL`: removed with app recordings.

## Roll Back

Going back to v1.3 means restoring the backup. A `helm rollback` or image change alone starts v1.3 on a database it cannot read.

1. Stop v1.4 the same way you stopped v1.3. Its connections block the restore.
2. Replace the database with the backup. This drops the tables v1.4 created, so it runs as the PostgreSQL superuser:

   ```bash
   PGSUPER=$(kubectl get secret archestra-platform-postgresql -n archestra -o jsonpath='{.data.postgres-password}' | base64 -d)
   kubectl exec -i -n archestra archestra-platform-postgresql-0 -- \
     env PGPASSWORD="$PGSUPER" pg_restore -U postgres -d postgres --clean --if-exists --create < archestra-v1.3.dump
   ```

3. Run `helm rollback archestra-platform <v1.3 revision> -n archestra`, then scale the web and worker Deployments back up. `helm history archestra-platform -n archestra` lists the revisions.

With Docker, stop and remove the v1.4 container, replace both volumes with the archives, and start `archestra/platform:1.3.81` with the same `docker run` command:

```bash
for volume in archestra-postgres-data archestra-app-data; do
  docker volume rm "$volume"
  docker run --rm -v "$volume":/data -v "$PWD":/backup alpine \
    tar xzf "/backup/$volume-v1.3.tgz" -C /data
done
```
