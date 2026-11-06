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

On Amazon RDS or Aurora PostgreSQL, enable IAM database authentication so each new connection in the query pool, cache pool, LISTEN/NOTIFY client, and migration Job signs a fresh 15-minute IAM token instead of using a static password.

### 1. Prepare the PostgreSQL Database and IAM Role

Enable IAM database authentication on your RDS or Aurora PostgreSQL instance, then connect as the master user and create the IAM-enabled database user and `pgvector` extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE USER archestra_iam WITH LOGIN;
GRANT rds_iam TO archestra_iam;
GRANT ALL PRIVILEGES ON DATABASE archestra TO archestra_iam;
\c archestra
GRANT ALL ON SCHEMA public TO archestra_iam;
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
      # Optional when connecting through a custom DNS name instead of *.rds.amazonaws.com:
      # awsRegion: eu-west-1
  env:
    ARCHESTRA_DATABASE_URL: postgresql://archestra_iam@mydb.123456789012.eu-west-1.rds.amazonaws.com:5432/archestra?sslmode=verify-full
```

The platform image includes the AWS RDS global CA bundle at `/etc/ssl/certs/cloud-database-ca-bundle.pem` and verifies the server certificate and hostname on every connection.

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

Set `archestra.database.connectionBudget` for peak web and worker pods, including overlap during a rollout. Reserve connections for other database clients. Each peak pod needs at least 13 budgeted connections; the chart rejects smaller budgets.

A fixed `archestra.database.poolMax` or [`ARCHESTRA_DATABASE_POOL_MAX`](/docs/admin/deployment/configuration#ARCHESTRA_DATABASE_POOL_MAX) overrides budget sizing. Finish one rollout before starting another.
