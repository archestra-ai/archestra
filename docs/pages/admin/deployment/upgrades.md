---
title: Upgrades
description: Upgrade a deployment and preserve its database and keys
order: 3
lastUpdated: 2026-10-22
---

Pin an exact chart version or image tag from [GitHub Releases](https://github.com/archestra-ai/archestra/releases). Tags ending in `-rc.N` are release candidates.

## Upgrade with Helm

1. Back up PostgreSQL and preserve authentication, credential-encryption, and content-encryption keys.
2. Read the selected release's migration and compatibility notes.
3. Test the release against a staging database before production.
4. Run the [Helm installation command](/docs/admin/deployment#install-with-helm) with the new version and your current values. Update `archestra.imageTag` too: an old values file or `--reuse-values` can keep the old image. Alternatively, use `--reset-then-reuse-values` to pick up chart defaults.
5. Confirm the migration Job succeeds, the rollout completes, and a model request appears in **Logs → LLM Proxy**.

Keep the migration Job enabled unless your pipeline applies migrations separately. A successful `/health` response only confirms the process is alive; `/ready` returns HTTP 503 until the API is ready.

## Let Active Requests Finish

Keep `archestra.terminationGracePeriodSeconds` at least **120**. Archestra stops accepting new model requests during shutdown and allows active requests up to 60 seconds to finish; longer requests can lose their connection.

For Docker, use `docker stop --time 120` or Compose's `stop_grace_period: 120s`.

## Roll Back

Follow the selected release's rollback instructions. Reverting a container image does not reverse database migrations; a rollback can require restoring a compatible database backup.

If you enabled the Logs user-picker summary, [disable it before starting an older binary](/docs/admin/deployment/database#large-log-histories).

## Upgrade Older OAuth Clients

The unified OAuth Clients migration requires stopping older replicas before starting the updated application. Mixed versions and rolling back to the older authorization model are unsupported. Back up PostgreSQL first.

Client IDs, secrets, provider keys, gateway assignments, and tokens carry over. After upgrading, review **Settings → OAuth Clients** for each client's capabilities and permissions.
