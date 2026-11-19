---
title: Cloud SQL and AlloyDB
description: Connect Archestra to Google Cloud SQL or AlloyDB for PostgreSQL through Google's auth proxy and Workload Identity
order: 2
lastUpdated: 2026-11-14
---

Run Google's auth proxy beside Archestra: the Cloud SQL Auth Proxy for Cloud SQL, or the AlloyDB Auth Proxy for AlloyDB. The chart adds it to the web, worker, and migration pods. It reaches the instance over private IP, encrypts the connection, and signs in as a Google service account through Workload Identity.

Before you start, give the instance a private IP in the cluster's VPC, turn on its IAM authentication flag (`cloudsql.iam_authentication` on Cloud SQL, `alloydb.iam_authentication` on AlloyDB), and turn on Workload Identity in the GKE cluster. The AlloyDB Auth Proxy image runs on amd64 nodes only.

## Connect Through the Auth Proxy

1. Create a Google service account that can connect to the database and sign in to it:

   ```bash
   gcloud iam service-accounts create archestra-db --project=PROJECT_ID
   for role in roles/cloudsql.client roles/cloudsql.instanceUser; do
     gcloud projects add-iam-policy-binding PROJECT_ID \
       --member="serviceAccount:archestra-db@PROJECT_ID.iam.gserviceaccount.com" \
       --role="$role"
   done
   ```

   For AlloyDB, grant `roles/alloydb.client`, `roles/alloydb.databaseUser`, and `roles/serviceusage.serviceUsageConsumer` instead.

2. Let Archestra's Kubernetes ServiceAccount use it. In the [installation example](/docs/admin/deployment/helm), that is `archestra-platform` in the `archestra` namespace:

   ```bash
   gcloud iam service-accounts add-iam-policy-binding \
     archestra-db@PROJECT_ID.iam.gserviceaccount.com \
     --role="roles/iam.workloadIdentityUser" \
     --member="serviceAccount:PROJECT_ID.svc.id.goog[archestra/archestra-platform]"
   ```

3. Add the service account as a database user:

   ```bash
   # Cloud SQL
   gcloud sql users create archestra-db@PROJECT_ID.iam \
     --instance=INSTANCE --type=cloud_iam_service_account
   # AlloyDB
   gcloud alloydb users create archestra-db@PROJECT_ID.iam \
     --cluster=CLUSTER --region=REGION --type=IAM_BASED
   ```

4. Connect to the `archestra` database as the `postgres` user, create the extensions, and grant the new user access:

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   GRANT ALL PRIVILEGES ON DATABASE archestra TO "archestra-db@PROJECT_ID.iam";
   GRANT ALL ON SCHEMA public TO "archestra-db@PROJECT_ID.iam";
   ```

   If Archestra's tables already exist under another user, such as `archestra`, also run `GRANT archestra TO "archestra-db@PROJECT_ID.iam";` so migrations can still change them.

5. Turn on the proxy and point Archestra at it:

   ```yaml
   postgresql:
     enabled: false
     external_database_url: "postgresql://archestra-db%40PROJECT_ID.iam@127.0.0.1:5432/archestra?sslmode=disable"
   archestra:
     database:
       cloudSqlProxy:
         enabled: true
         instanceConnectionName: PROJECT_ID:REGION:INSTANCE
     orchestrator:
       kubernetes:
         serviceAccount:
           annotations:
             iam.gke.io/gcp-service-account: archestra-db@PROJECT_ID.iam.gserviceaccount.com
   ```

   For AlloyDB, replace the `cloudSqlProxy` block with:

   ```yaml
   archestra:
     database:
       alloyDbProxy:
         enabled: true
         instanceUri: projects/PROJECT_ID/locations/REGION/clusters/CLUSTER/instances/INSTANCE
   ```

   The URL names the IAM user and holds no secret. `sslmode=disable` covers only the hop inside the pod; the proxy encrypts the connection to the database. For an AlloyDB instance on Private Service Connect, add `--psc` to `archestra.database.alloyDbProxy.args`.

6. Run the Helm upgrade. It worked when the migration Job completes and the web pods turn ready.

## When It Does Not Work

- **Migration Job cannot connect:** run `kubectl logs <pod> -c cloud-sql-proxy` (or `-c alloydb-auth-proxy`) on its pod. A 403 means the service account lacks the client role from the first step or the Workload Identity binding.
- **The IAM user cannot sign in** (`Cloud SQL IAM service account authentication failed` on Cloud SQL): the service account lacks its database user role, the database user is missing, or the IAM authentication flag is off.
- **`permission denied for schema public`:** run the grants as the `postgres` user.
