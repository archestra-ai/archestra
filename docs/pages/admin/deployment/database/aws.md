---
title: Amazon RDS and Aurora
description: Connect Archestra to Amazon RDS or Aurora PostgreSQL with IAM database authentication, directly or through RDS Proxy
order: 1
---

<!-- Check docs writer skill at .agents/skills/archestra-docs-writer/SKILL.md -->

On Amazon RDS or Aurora PostgreSQL, each new connection in the query pool, cache pool, LISTEN/NOTIFY client, and migration Job signs a fresh 15-minute token with the pod's IAM role, so Archestra stores no database password.

- **Network:** set **Public access** to **No**, put the instance in private subnets, and allow port 5432 in its security group only from the cluster.
- **TLS:** IAM authentication always verifies the server certificate. The platform image ships the RDS CA bundle.

## Prepare the Database and IAM Role

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

## Configure the Helm Chart on Amazon EKS

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

## Clusters Outside AWS

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

## Connect Through RDS Proxy

Put [RDS Proxy](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html) in front of the database when you want failovers to stay behind one endpoint: Archestra keeps signing IAM tokens, now for the proxy, with no chart change. Archestra holds session state on most connections (prepared statements, `LISTEN`, advisory locks), so the proxy pins them and pools little; size the proxy for the same [connection budget](/docs/admin/deployment/database#connection-capacity) as the database.

1. Create the proxy with IAM authentication for clients. With end-to-end IAM authentication, the proxy also signs in to the database with IAM and needs no Secrets Manager secret; the database user still needs `rds_iam`, as in [Prepare the Database and IAM Role](#prepare-the-database-and-iam-role).
2. Allow `rds-db:connect` on the proxy's resource ID (`prx-…`), not the database's:

   ```json
   {
     "Effect": "Allow",
     "Action": "rds-db:connect",
     "Resource": "arn:aws:rds-db:eu-west-1:123456789012:dbuser:prx-ABCDEFGHIJKL01234/archestra_iam"
   }
   ```

3. Point the URL at the proxy endpoint and run the Helm upgrade. It worked when the migration Job completes and the web pods turn ready:

   ```yaml
   archestra:
     env:
       ARCHESTRA_DATABASE_URL: postgresql://archestra_iam@archestra.proxy-abc123xyz.eu-west-1.rds.amazonaws.com:5432/archestra?sslmode=verify-full
   ```

- **TLS:** the proxy presents an AWS Certificate Manager certificate, which the platform image already trusts. Leave `sslrootcert` unset, because the RDS CA bundle does not cover the proxy, and use the proxy endpoint name rather than a DNS alias.
- **Statement timeout:** Archestra sends [`ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS`](/docs/admin/deployment/configuration#ARCHESTRA_DATABASE_STATEMENT_TIMEOUT_MILLIS) as a startup parameter, and RDS Proxy accepts only a fixed set of them. If connections fail with an error that names `statement_timeout`, set it to `0` and set the timeout on the role instead: `ALTER ROLE archestra_iam SET statement_timeout = '30s';`.
