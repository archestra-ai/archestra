---
title: PostgreSQL
description: Choose, size, and connect the PostgreSQL database that holds Archestra's state
order: 4
explore: false
---

<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

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
- **Connections:** set the `max_connections` flag to the size's [Max Connections](/docs/admin/deployment/scaling#pick-a-size). The memory-based default can be lower.
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

<span id="amazon-rds-iam-authentication"></span><span id="1-prepare-the-postgresql-database-and-iam-role"></span><span id="2-configure-the-helm-chart-on-amazon-eks"></span><span id="3-non-aws-kubernetes-clusters-gke-aks-openshift-on-prem"></span><span id="4-connect-through-rds-proxy"></span><span id="connect-with-a-password"></span><span id="verify-tls-certificates"></span>

On AWS, Google Cloud, and Azure, Archestra's pods sign in to the database with their cloud identity, so no database password exists to leak or rotate. Follow the page for your database:

- [Amazon RDS and Aurora](/docs/admin/deployment/database/aws): each connection signs a short-lived token with the pod's IAM role, directly or through RDS Proxy.
- [Cloud SQL and AlloyDB](/docs/admin/deployment/database/google-cloud): Google's auth proxy runs beside each pod and signs in as a Google service account.
- [Azure Database for PostgreSQL](/docs/admin/deployment/database/azure): each connection signs in with the pod's managed identity through Microsoft Entra ID.
- [Any other PostgreSQL](/docs/admin/deployment/database/password): a connection URL with a password, kept in a Kubernetes Secret.

On every cloud, keep the database on a private network with no public endpoint, connect as a user that owns only the Archestra database, and verify TLS.

- **Changing the pod's identity:** when you change `roleArn`, an `iam.gke.io/gcp-service-account` annotation, or an Entra `clientId`, the migration Job runs before Helm updates the platform ServiceAccount, so that upgrade's Job still uses the old identity. Set `archestra.migrationJob.serviceAccount.create: true` to give the Job its own ServiceAccount with the current annotations, named after the platform ServiceAccount plus `-migrate`. Allow that name in the role's trust policy, Workload Identity binding, or federated credential first.

## Connection Capacity

Set `archestra.database.connectionBudget` to the connections Archestra may use, and the chart divides it among pods. Each pod gets the budget divided by the peak pod count. During a rolling update, each Deployment can run its full new revision, an old revision that is still terminating, and the surge (25% by default, rounded up). With the web HPA maximum at 5 and 2 workers, that is 12 web and 5 worker pods, so 17 peak pods.

Each pod keeps 12 of its share for caching and notifications and uses the rest as its query pool. A share under 13 leaves no query connection, and the chart rejects that budget.

- Set PostgreSQL `max_connections` about 25% above the budget. Each pod opens a few connections the budget does not count, and migrations and monitoring need their own. [Pick a Size](/docs/admin/deployment/scaling#pick-a-size) gives a budget for each size.
- A fixed `archestra.database.poolMax` or [`ARCHESTRA_DATABASE_POOL_MAX`](/docs/admin/deployment/configuration#ARCHESTRA_DATABASE_POOL_MAX) overrides budget sizing. Finish one rollout before starting another.
- Archestra does not need a connection pooler. Behind PgBouncer in transaction mode, point [`ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL) at a direct connection.
