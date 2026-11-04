---
title: PostgreSQL
description: Choose, size, and connect the PostgreSQL database that holds Archestra's state
order: 4
lastUpdated: 2026-11-04
---

<span id="large-log-histories"></span><span id="docker-persistence"></span>

PostgreSQL holds all of Archestra's state, so its backups and failover are your instance's backups and failover. Use a managed database in production: the Helm chart's bundled database runs one replica with no standby.

## Choose a Database

Archestra needs PostgreSQL 15 or newer; use 17 or 18. It also needs the `vector` (pgvector 0.8 or newer) and `pg_trgm` extensions, which every major cloud's managed PostgreSQL offers.

- Archestra's migrations create both extensions. The migration user must be allowed to, or a database administrator must create them first.
- Older pgvector versions can return fewer knowledge base results when a search filters by document.
- Archestra pools its own connections and sends every query to the primary. Connect it to the primary directly; a read replica adds no capacity.

### Cloud Recommendations

Pick the instance for your [size](/docs/admin/deployment/scaling#pick-a-size), turn on a standby in a second zone, and keep point-in-time recovery on.

:::tabs
@tab AWS
Amazon RDS for PostgreSQL fits every size. Aurora PostgreSQL also works and grows its storage on its own; it offers memory-optimized classes only.

| Size | RDS Instance | Aurora Instance | RDS Storage |
| --- | --- | --- | --- |
| Small | `db.m7g.large` | `db.r7g.large` | 100 GiB gp3 |
| Medium | `db.m7g.xlarge` | `db.r7g.xlarge` | 250 GiB gp3 |
| Large | `db.m7g.2xlarge`, or `db.r7g.2xlarge` for a large knowledge base | `db.r7g.2xlarge` | 500 GiB gp3 |

- **High availability:** create a Multi-AZ deployment, or add an Aurora replica in another Availability Zone.
- **Backups:** automated backups give point-in-time recovery. Keep at least seven days.
- **Extensions:** the master user can create `vector` and `pg_trgm`. Pick an engine version that ships pgvector 0.8 or newer.
- **Storage:** turn on storage autoscaling. A gp3 volume under 400 GiB is fixed at 3,000 IOPS; grow it to 400 GiB to provision more.
- **Connections:** the default `max_connections` follows instance memory and covers each size.
- **Avoid:** burstable `db.t4g` classes. They slow down when CPU credits run out.
@tab Google Cloud
Cloud SQL for PostgreSQL fits every size. Enterprise Plus edition has shorter maintenance downtime and keeps point-in-time recovery longer. AlloyDB for PostgreSQL also works, with the same extensions.

| Size | Cloud SQL Enterprise | Cloud SQL Enterprise Plus | Storage |
| --- | --- | --- | --- |
| Small | `db-custom-2-8192` (2 vCPU, 8 GB) | `db-perf-optimized-N-2` (2 vCPU, 16 GB) | 100 GB SSD |
| Medium | `db-custom-4-16384` (4 vCPU, 16 GB) | `db-perf-optimized-N-4` (4 vCPU, 32 GB) | 250 GB SSD |
| Large | `db-custom-8-32768` (8 vCPU, 32 GB) | `db-perf-optimized-N-8` (8 vCPU, 64 GB) | 500 GB SSD |

- **High availability:** turn on regional availability. The standby runs in another zone.
- **Backups:** turn on automated backups and point-in-time recovery.
- **Extensions:** the `postgres` user can create `vector` and `pg_trgm`.
- **Storage:** keep automatic storage increases on. Cloud SQL sets IOPS and throughput from the machine type and disk size, so grow the disk to raise them.
- **Connections:** Cloud SQL sets `max_connections` from instance memory, which covers the Small and Medium sizes. For Large, set the `max_connections` flag to at least 1,000.
- **Network:** connect over private IP from the cluster's VPC.
@tab Azure
Azure Database for PostgreSQL flexible server fits every size. Use the General Purpose tier, and Memory Optimized for a large knowledge base.

| Size | Compute | Storage |
| --- | --- | --- |
| Small | General Purpose `Standard_D2ds_v5` | 128 GiB Premium SSD |
| Medium | General Purpose `Standard_D4ds_v5` | 256 GiB Premium SSD |
| Large | General Purpose `Standard_D8ds_v5`, or Memory Optimized `Standard_E8ds_v5` | 512 GiB Premium SSD |

- **Extensions:** add `VECTOR` and `PG_TRGM` to the `azure.extensions` server parameter before you install Archestra. Without them, the first migration fails.
- **High availability:** turn on zone-redundant high availability.
- **Backups:** point-in-time recovery is automatic; keep at least seven days. Geo-redundant backup can only be chosen when you create the server.
- **Storage:** turn on storage autogrow.
- **Connections:** connect on port 5432. The fixed `max_connections` of each General Purpose and Memory Optimized size covers the matching Archestra size.
- **Avoid:** the Burstable tier. It slows down when CPU credits run out.
:::

## Connect a Database

Connect the application and migration Job to the same PostgreSQL database. Archestra migrations require the pgvector extension. The migration user must be able to create the extension, or a database administrator must install it first.

1. In the Helm release namespace (`archestra` in the installation example), create a Kubernetes Secret named `archestra-database` with the complete connection URL in its `url` key.
2. Reference it in the shared application settings:

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
   ```

   The migration Job inherits this Secret reference. The chart runs migrations before rolling out an upgrade. Keep `archestra.migrationJob.enabled` enabled unless your pipeline applies migrations separately.

3. Apply the Helm upgrade and confirm the migration Job succeeds before checking the application rollout.

## Verify TLS Certificates

To verify the database server certificate, mount your CA bundle in every database client and include `?sslmode=verify-full&sslrootcert=/etc/ssl/db/ca.pem` in the database URL:

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

Set `archestra.database.connectionBudget` to the connections Archestra may use, and the chart divides it among pods. Each pod gets the budget divided by the peak pod count: the web HPA maximum and the worker count, each plus rollout surge (25% by default). Each peak pod needs at least 13 budgeted connections; the chart rejects smaller budgets.

- Set PostgreSQL `max_connections` about 25% above the budget. Each pod opens a few connections the budget does not count, and migrations and monitoring need their own. [Pick a Size](/docs/admin/deployment/scaling#pick-a-size) gives a budget for each size.
- A fixed `archestra.database.poolMax` or [`ARCHESTRA_DATABASE_POOL_MAX`](/docs/admin/deployment/configuration#ARCHESTRA_DATABASE_POOL_MAX) overrides budget sizing. Finish one rollout before starting another.
- Archestra does not need a connection pooler. Behind PgBouncer in transaction mode, point [`ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL) at a direct connection.
