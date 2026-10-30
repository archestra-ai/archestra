---
title: PostgreSQL
description: Connect an external database and size its connection pools
order: 3
lastUpdated: 2026-10-30
---

<span id="large-log-histories"></span><span id="docker-persistence"></span>

Use an external PostgreSQL database for managed backups and availability. The Helm chart's bundled database runs one replica.

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

On Amazon RDS or Aurora PostgreSQL, enable IAM database authentication so each new connection in the query pool, cache pool, LISTEN/NOTIFY client, and migration Job signs a fresh 15-minute IAM token instead of using a static password:

```yaml
postgresql:
  enabled: false
archestra:
  database:
    iamAuth:
      enabled: true
      # Optional when connecting through a custom DNS name instead of *.rds.amazonaws.com:
      # awsRegion: eu-west-1
  env:
    ARCHESTRA_DATABASE_URL: postgresql://archestra_iam@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra?sslmode=verify-full
```

Grant `rds_iam` to the PostgreSQL user and allow `rds-db:connect` on the pod's IAM role (via IRSA or EKS Pod Identity). The platform image includes the AWS RDS global CA bundle at `/etc/ssl/certs/cloud-database-ca-bundle.pem` and verifies the server certificate and hostname on every connection.

## Connection Capacity

Set `archestra.database.connectionBudget` for peak web and worker pods, including overlap during a rollout. Reserve connections for other database clients. Each peak pod needs at least 13 budgeted connections; the chart rejects smaller budgets.

A fixed `archestra.database.poolMax` or [`ARCHESTRA_DATABASE_POOL_MAX`](/docs/admin/deployment/configuration#ARCHESTRA_DATABASE_POOL_MAX) overrides budget sizing. Finish one rollout before starting another.
