---
title: PostgreSQL
description: Choose, size, and connect the PostgreSQL database that holds Archestra's state
order: 4
lastUpdated: 2026-11-06
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

## Amazon RDS IAM Authentication

On Amazon RDS or Aurora PostgreSQL, enable IAM database authentication so each new connection in the query pool, cache pool, LISTEN/NOTIFY client, and migration Job signs a fresh 15-minute IAM token instead of using a static password.

### 1. Prepare the PostgreSQL Database and IAM Role

Enable IAM database authentication on your RDS or Aurora PostgreSQL instance, then connect as the master user to configure the `archestra` application database, required extensions, and IAM database role.

- **New database**: Switch to the `archestra` database first so `vector` and `pg_trgm` are installed in the application database, then create the IAM-enabled role and grant database and schema privileges:

  ```sql
  \c archestra
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE USER archestra_iam WITH LOGIN;
  GRANT rds_iam TO archestra_iam;
  GRANT ALL PRIVILEGES ON DATABASE archestra TO archestra_iam;
  GRANT ALL ON SCHEMA public TO archestra_iam;
  ```

- **Existing Archestra database**: Grant `rds_iam` directly to the existing database role that owns Archestra's tables and sequences (for example, `archestra`) and keep that username in [`ARCHESTRA_DATABASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_DATABASE_URL) and the `rds-db:connect` policy so table ownership and migration DDL (`ALTER TABLE`) privileges remain intact:

  ```sql
  \c archestra
  CREATE EXTENSION IF NOT EXISTS vector;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  GRANT rds_iam TO archestra;
  ```

  If you must switch an existing database from its original owner role (`archestra`) to a separate `archestra_iam` role, also transfer object ownership and privileges in the `archestra` database so both application DML and migration DDL succeed:

  ```sql
  \c archestra
  CREATE USER archestra_iam WITH LOGIN;
  GRANT rds_iam TO archestra_iam;
  GRANT ALL PRIVILEGES ON DATABASE archestra TO archestra_iam;
  GRANT ALL ON SCHEMA public TO archestra_iam;
  GRANT archestra TO archestra_iam;
  REASSIGN OWNED BY archestra TO archestra_iam;
  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO archestra_iam;
  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO archestra_iam;
  GRANT ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public TO archestra_iam;
  ```

Attach an IAM policy to the pod's IAM role allowing `rds-db:connect` for the RDS resource ID (`DbiResourceId`) and database username:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "rds-db:connect",
      "Resource": "arn:aws:rds-db:eu-west-1:123456789012:dbuser:db-ABCDEFGHIJKLMNOPQRSTUVWX/archestra_iam"
    }
  ]
}
```

### 2. Configure the Helm Chart on Amazon EKS

On Amazon EKS, set `archestra.database.iamAuth.enabled: true` and `archestra.database.iamAuth.roleArn` (for IRSA) or bind the role with EKS Pod Identity:

```yaml
postgresql:
  enabled: false
archestra:
  database:
    iamAuth:
      enabled: true
      # Annotates the platform ServiceAccount with eks.amazonaws.com/role-arn (omit when using EKS Pod Identity):
      roleArn: arn:aws:iam::123456789012:role/archestra-rds-iam-role
      # Optional override when the endpoint hostname does not embed the AWS region
      # (TLS hostname verification checks the URL hostname against the server certificate,
      # so the URL must use an endpoint name covered by the certificate):
      # awsRegion: eu-west-1
  env:
    ARCHESTRA_DATABASE_URL: postgresql://archestra_iam@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra?sslmode=verify-full
```

The platform image includes the AWS RDS global CA bundle at `/etc/ssl/certs/cloud-database-ca-bundle.pem` and verifies the server certificate and URL hostname on every connection (`sslmode=no-verify` is rejected under IAM auth); use an endpoint hostname covered by the server certificate (such as the RDS instance, cluster, or RDS Proxy endpoint, or a custom certificate covering your alias).

### 3. Non-AWS Kubernetes Clusters (GKE, AKS, OpenShift, on-prem)

When running outside AWS with network connectivity to RDS on port `5432`, you can authenticate using either OIDC federation or Kubernetes Secrets:

- **OIDC federation (recommended)**: Register your cluster's OIDC issuer in AWS IAM and enable `injectWebIdentityTokenVolume` so the chart mounts a projected `sts.amazonaws.com` ServiceAccount token volume and sets `AWS_ROLE_ARN` and `AWS_WEB_IDENTITY_TOKEN_FILE` on web, worker, and migration Job pods:

  ```yaml
  postgresql:
    enabled: false
  archestra:
    database:
      iamAuth:
        enabled: true
        roleArn: arn:aws:iam::123456789012:role/archestra-rds-iam-role
        injectWebIdentityTokenVolume: true
    env:
      ARCHESTRA_DATABASE_URL: postgresql://archestra_iam@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra?sslmode=verify-full
  ```

- **Secret-backed AWS credentials**: Supply `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and optional `AWS_SESSION_TOKEN` through `archestra.envFromSecrets` (or `archestra.env`, where the chart automatically stores `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` in a Kubernetes Secret).

## Connection Capacity

Set `archestra.database.connectionBudget` to the connections Archestra may use, and the chart divides it among pods. Each pod gets the budget divided by the peak pod count. During a rolling update, each Deployment can run its full new revision, an old revision that is still terminating, and the surge (25% by default, rounded up). With the web HPA maximum at 5 and 2 workers, that is 12 web and 5 worker pods, so 17 peak pods.

Each pod keeps 12 of its share for caching and notifications and uses the rest as its query pool. A share under 13 leaves no query connection, and the chart rejects that budget.

- Set PostgreSQL `max_connections` about 25% above the budget. Each pod opens a few connections the budget does not count, and migrations and monitoring need their own. [Pick a Size](/docs/admin/deployment/scaling#pick-a-size) gives a budget for each size.
- A fixed `archestra.database.poolMax` or [`ARCHESTRA_DATABASE_POOL_MAX`](/docs/admin/deployment/configuration#ARCHESTRA_DATABASE_POOL_MAX) overrides budget sizing. Finish one rollout before starting another.
- Archestra does not need a connection pooler. Behind PgBouncer in transaction mode, point [`ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL`](/docs/admin/deployment/configuration#ARCHESTRA_CHAT_ACTIVE_RUN_NOTIFY_DATABASE_URL) at a direct connection.
