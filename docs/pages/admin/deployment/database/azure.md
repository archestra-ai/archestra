---
title: Azure Database for PostgreSQL
description: Connect Archestra to Azure Database for PostgreSQL flexible server with Microsoft Entra ID and AKS Workload Identity
order: 3
lastUpdated: 2026-11-14
---

Use Microsoft Entra ID authentication: each new connection signs in with an Entra access token for the pod's managed identity, through AKS Workload Identity. Archestra renews the token before it expires.

Before you start, give the server private access (VNet integration) or a private endpoint in the cluster's VNet, set its authentication to include Microsoft Entra, and add yourself as a Microsoft Entra admin. AKS needs the OIDC issuer and Workload Identity on; [On AKS](/docs/llm-proxy/providers/azure#on-aks) has the commands.

## Connect with Microsoft Entra ID

1. Create a user-assigned managed identity and let Archestra's Kubernetes ServiceAccount use it. In the [installation example](/docs/admin/deployment/helm), that is `archestra-platform` in the `archestra` namespace. Pods have one Azure identity, so if Archestra already uses one for Azure OpenAI, grant that one instead.

   ```bash
   az identity create --name archestra-db --resource-group RESOURCE_GROUP
   az identity federated-credential create \
     --name archestra-platform \
     --identity-name archestra-db \
     --resource-group RESOURCE_GROUP \
     --issuer "$(az aks show --name CLUSTER --resource-group RESOURCE_GROUP --query oidcIssuerProfile.issuerUrl -o tsv)" \
     --subject system:serviceaccount:archestra:archestra-platform \
     --audiences api://AzureADTokenExchange
   ```

2. Sign in as the Entra admin, connect to the `postgres` database, and create a role for the identity:

   ```sql
   SELECT * FROM pgaadauth_create_principal('archestra-db', false, false);
   ```

3. Connect to the `archestra` database as the Entra admin, create the extensions, and grant the role access:

   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   CREATE EXTENSION IF NOT EXISTS pg_trgm;
   GRANT ALL PRIVILEGES ON DATABASE archestra TO "archestra-db";
   GRANT ALL ON SCHEMA public TO "archestra-db";
   ```

   If Archestra's tables already exist under another user, such as `archestra`, also run `GRANT archestra TO "archestra-db";` so migrations can still change them.

4. Turn on Entra authentication and point Archestra at the server. `clientId` is the output of `az identity show --name archestra-db --resource-group RESOURCE_GROUP --query clientId -o tsv`:

   ```yaml
   postgresql:
     enabled: false
     external_database_url: "postgresql://archestra-db@SERVER.postgres.database.azure.com:5432/archestra?sslmode=verify-full"
   archestra:
     database:
       entraAuth:
         enabled: true
         clientId: CLIENT_ID
   ```

   The URL names the identity and holds no secret. The chart adds the Workload Identity annotation and pod label for that client ID. Archestra always verifies the server certificate and refuses `sslmode=disable`.

5. Run the Helm upgrade. It worked when the migration Job completes and the web pods turn ready.

## When It Does Not Work

- **The migration Job gets no token** (a `DefaultAzureCredential` error): the federated credential's subject does not match the ServiceAccount, or the cluster's Workload Identity is off.
- **`password authentication failed`:** the role is missing or has another name. Create it in the `postgres` database with the identity's exact name.
- **`permission denied for schema public`:** run the grants as the Entra admin.
