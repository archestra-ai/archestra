---
title: PostgreSQL
description: Connect an external database and size its connection pools
order: 1
lastUpdated: 2026-10-22
---

Use an external PostgreSQL database for managed backups and availability. The Helm chart's bundled database runs one replica.

## Connect a Database

For Knowledge Base vector storage, PostgreSQL needs pgvector. The migration user must be able to create the extension, or a database administrator must install it first.

1. In the Helm release namespace (`archestra` in the installation example), create a Kubernetes Secret named `archestra-database` with the complete connection URL in its `url` key.
2. Reference it from both the application and migration Job:

   ```yaml
   postgresql:
     enabled: false
   archestra:
     envWithValueFrom:
       - name: ARCHESTRA_DATABASE_URL
         valueFrom:
           secretKeyRef:
             name: archestra-database
             key: url
     migrationJob:
       envWithValueFrom:
         - name: ARCHESTRA_DATABASE_URL
           valueFrom:
             secretKeyRef:
               name: archestra-database
               key: url
   ```

   Provide the same database URL to the migration Job and application. The chart runs migrations before rolling out an upgrade. Keep `archestra.migrationJob.enabled` enabled unless your pipeline applies migrations separately.

3. Apply the Helm upgrade and confirm the migration Job succeeds before checking the application rollout.

## Verify TLS Certificates

Mount your CA bundle in every database client and include `?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem` in the database URL:

```yaml
archestra:
  extraVolumes:
    - name: db-ca
      secret:
        secretName: db-ca-bundle
  extraVolumeMounts:
    - name: db-ca
      mountPath: /etc/ssl/db
      readOnly: true
```

The chart applies these mounts to web pods, worker pods, and the migration Job. Use a Secret or ConfigMap for the CA; the migration Job skips persistent-volume claims.

## Connection Capacity

Set `archestra.database.connectionBudget` for peak web and worker pods, including overlap during a rollout. Reserve connections for other database clients. Each peak pod needs at least 13 budgeted connections; the chart rejects smaller budgets.

A fixed `archestra.database.poolMax` or [`ARCHESTRA_DATABASE_POOL_MAX`](/docs/admin/deployment/configuration#ARCHESTRA_DATABASE_POOL_MAX) overrides budget sizing. Finish one rollout before starting another.

## Large Log Histories

Run maintenance from `/app/backend` in an application container after migrations finish.

**Speed up Costs statistics:** create the optional covering index during a database maintenance window:

```bash
node scripts/create-statistics-index.mjs
```

Use a direct database connection or session pooling, with index-creation privileges. Transaction pooling is unsupported. The index consumes storage and database I/O; successful output reports `created`, `already_valid`, or `rebuilt_invalid`.

**Speed up the Logs user picker:** first upgrade every interaction writer and stop old binaries, then run:

```bash
node dist/standalone-scripts/rebuild-interaction-user-activity.mjs --enable
```

Confirm `ready: true`. Exit code 2 means work is incomplete; rerun without `--enable` to resume. The worker also resumes it automatically, and Logs uses exact queries until it is ready. Before running older binaries or direct database maintenance, run with `--disable`. Re-enable afterward to rebuild.

## Docker Persistence

Set [`ARCHESTRA_DATABASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_DATABASE_URL) to connect a Docker instance to an external database. Otherwise, preserve `/var/lib/postgresql/data` for the bundled database. Keep `/app/data` persistent for generated secrets in either case.
