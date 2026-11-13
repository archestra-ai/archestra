---
title: Blob Providers
description: Connect an Amazon S3 bucket, a Google Cloud Storage bucket, or an Azure Blob Storage container once, so features that write files, such as scheduled cost exports, send them there
order: 6
lastUpdated: 2026-11-11
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect your organization's bucket once, and Archestra features that write files send them there. A [scheduled cost export](/docs/llm-proxy/costs-and-limits/exports#schedule-exports-to-object-storage) picks the provider by name and never sees its credentials, so nobody pastes cloud keys into each feature. On AWS, Google Cloud, and Azure, Archestra can sign in as its own pod identity, so there is no key to store or rotate.

A blob provider writes to one of three stores:

| Provider | Writes to | A file's location |
| --- | --- | --- |
| Amazon S3 | An S3 bucket, or an S3-compatible store such as MinIO, Cloudflare R2, or Ceph | `s3://<bucket>/<key>` |
| Google Cloud Storage | A Cloud Storage bucket | `gs://<bucket>/<key>` |
| Azure Blob Storage | A container in a storage account | `https://<account>.blob.core.windows.net/<container>/<key>` |

## Add a Blob Provider

Add one provider per bucket or container, and every feature that writes files can pick it. Viewing blob providers requires [`organizationSettings:read`](/docs/reference/permissions#organizationSettings:read). Adding, changing, testing, or deleting one requires [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).

1. Grant access to the identity Archestra signs in as. See [Amazon S3](#set-up-amazon-s3), [Google Cloud Storage](#set-up-google-cloud-storage), or [Azure Blob Storage](#set-up-azure-blob-storage).
2. Go to **Settings → Blob Providers** and click **Add blob provider**.
3. Pick the **Provider** and enter a **Name**, such as `finops-bucket`. Features list the provider by this name, so it is unique in the organization.
4. Enter where files go:
   - Amazon S3: the **Bucket**, without `s3://`, and its **Region**, such as `eu-west-1`.
   - Google Cloud Storage: the **Bucket**, without `gs://`.
   - Azure Blob Storage: the **Storage account** and the **Container**.
5. Pick the **Authentication** method and fill in its fields.
6. Optionally, open **Advanced** and set a **Key prefix**: a folder that every object Archestra writes goes under. The custom endpoint, path-style addressing, external ID, and session token are there too.
7. Click **Test and add**.

Archestra writes and deletes a small test object under the key prefix before it saves. When the test works, the dialog closes and the provider shows in the table. When it fails:

- The dialog shows the store's error. Fix the setting, or click **Save anyway** to keep the provider as it is. See [Fix a Failed Connection Test](#fix-a-failed-connection-test).
- Through the API, the request fails with a 400 and the `internal_code` `blob_provider_connection_failed`. Send `skipConnectionTest: true` to save anyway.

What to know:

- Secrets go to Archestra's [secret storage](/docs/admin/deployment/secret-storage) and are never shown again. When you edit a provider, leave a secret field empty to keep the stored value.
- A provider's type cannot change after it is created. Add a new provider instead.
- A provider that a cost export uses cannot be deleted. Delete the export, or move it to another provider, first.

## Test a Provider

Test a provider again after you rotate a key, change an access policy, or see an export fail. The test writes and deletes the same small object as a save.

- One provider: click **Test connection** on its row.
- Several: select their rows and click **Test connection** above the table.

A check next to the name means the write worked. A cross means it failed: hover over it to read the error. The **Signs in as** column shows the identity each provider uses, and flags a provider whose stored secret is missing.

## Set Up Amazon S3

Archestra signs in to S3 in one of three ways. On AWS, prefer the pod's own identity: there is no key to store or rotate.

| Authentication | Use it when | You provide |
| --- | --- | --- |
| AWS default credential chain | Archestra runs on AWS with an IAM role: EKS (IRSA or EKS Pod Identity), ECS, or EC2. | Nothing. The role comes from the Archestra pods. |
| Assume IAM role | The bucket is in another AWS account, or you want a role used only for this bucket. | The role ARN and, under **Advanced**, the external ID if its trust policy requires one. Optionally, an access key to assume the role with. |
| Access key | Archestra runs outside AWS, or the store is S3-compatible. | An access key ID and secret access key. A session token under **Advanced** is optional. |

### Use the Pod's IAM Role

With the default chain, Archestra uses the same AWS identity as the rest of the process: environment variables, an IRSA or EKS Pod Identity role, an ECS task role, an EC2 instance profile, or shared config files. On EKS with IRSA, annotate the Archestra service account with the role:

```yaml
archestra:
  orchestrator:
    kubernetes:
      serviceAccount:
        annotations:
          eks.amazonaws.com/role-arn: arn:aws:iam::111122223333:role/archestra-blob-writer
```

The web and worker pods share this service account. The connection test runs on a web pod and scheduled exports run on a worker pod, so both get the role.

### Assume a Role in Another Account

Archestra assumes the role through STS, signing in as the default chain's identity, or as the stored access key when you add one. Allow that identity in the role's trust policy, and require the external ID you enter under **Advanced**:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::111122223333:role/archestra-platform" },
      "Action": "sts:AssumeRole",
      "Condition": { "StringEquals": { "sts:ExternalId": "archestra-cost-exports" } }
    }
  ]
}
```

The source identity also needs `sts:AssumeRole` on the role ARN in its own permissions. Attach the [bucket policy](#grant-bucket-access) to the assumed role, not to the source.

### Grant Bucket Access

The identity needs to write objects under the provider's key prefix, and nothing else. Scheduled exports use `s3:PutObject`. The connection test also deletes its test object, so it needs `s3:DeleteObject`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::example-finops-bucket/archestra/*"
    }
  ]
}
```

Replace `example-finops-bucket` with your bucket and `archestra` with the provider's key prefix. With no key prefix, use `arn:aws:s3:::example-finops-bucket/*`.

### Use an S3-Compatible Store

Under **Advanced**, set **Custom endpoint** to the store's S3 API URL and turn on **Path-style addressing**, which most S3-compatible stores require. Sign in with an access key from the store.

| Store | Endpoint |
| --- | --- |
| MinIO, Ceph, SeaweedFS | Your server's S3 URL, such as `https://minio.example.internal:9000` |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com`, with region `auto` |

**Region** is still required. Use the value the store documents for S3 clients. The endpoint must start with `http://` or `https://`, and Archestra's pods must reach it over the network.

## Set Up Google Cloud Storage

Archestra writes through the Cloud Storage JSON API, so it needs no HMAC key or interoperability setting. It signs in one of two ways:

- **Application Default Credentials:** the server's own Google identity, from GKE Workload Identity, an attached service account, or `GOOGLE_APPLICATION_CREDENTIALS`. Nothing is stored. Prefer it on Google Cloud.
- **Service account key:** a service account's JSON key, pasted into the provider. Use it when Archestra runs outside Google Cloud.

On GKE, annotate the Archestra service account with the Google service account to sign in as. [GKE with Workload Identity](/docs/llm-proxy/providers/gemini#gke-with-workload-identity-recommended) covers the binding between the two accounts.

```yaml
archestra:
  orchestrator:
    kubernetes:
      serviceAccount:
        annotations:
          iam.gke.io/gcp-service-account: archestra-exports@example-project.iam.gserviceaccount.com
```

Then grant that service account object access on the bucket:

```bash
gcloud storage buckets add-iam-policy-binding gs://example-finops-bucket \
  --member="serviceAccount:archestra-exports@example-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectUser"
```

What to know:

- The identity needs `storage.objects.create` and `storage.objects.delete`. `roles/storage.objectUser` holds both. For less access, grant a custom role with only those two.
- Cloud Storage also checks `storage.objects.delete` when a write replaces a file, so an export that rewrites a period fails without it.

## Set Up Azure Blob Storage

Archestra writes into one container of a storage account. It signs in one of four ways:

| Authentication | Use it when | You provide |
| --- | --- | --- |
| Azure default credential | Archestra runs on Azure with AKS Workload Identity or a managed identity, or has `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` set. | Nothing. |
| Service principal | Archestra runs outside Azure. | A Microsoft Entra app registration's tenant ID, client ID, and client secret. |
| Storage account key | Your policy allows account keys. | One of the storage account's access keys. It opens the whole account. |
| SAS token | You want a secret that reaches one container only. | A container SAS token with create, write, and delete permissions. |

For a sovereign cloud or Azurite, set **Custom endpoint** under **Advanced**, such as `https://finopsexports.blob.core.usgovcloudapi.net`.

### Grant Container Access

The Azure default credential and a service principal need the **Storage Blob Data Contributor** role on the container or the storage account:

```bash
az role assignment create \
  --assignee "<client-id>" \
  --role "Storage Blob Data Contributor" \
  --scope "/subscriptions/<subscription-id>/resourceGroups/<resource-group>/providers/Microsoft.Storage/storageAccounts/finopsexports/blobServices/default/containers/cost-exports"
```

Use the client ID of the managed identity or the app registration. On AKS, set up Workload Identity as in [On AKS](/docs/llm-proxy/providers/azure#on-aks): the service account annotation and the pod label are all a blob provider needs.

A new role assignment can take a few minutes to apply. A test right after it can fail with `AuthorizationPermissionMismatch`.

### Create a SAS Token

A SAS token limits Archestra to one container until the token expires. Issue it with create, write, and delete permissions (`cwd`):

```bash
az storage container generate-sas \
  --account-name finopsexports \
  --name cost-exports \
  --permissions cwd \
  --expiry 2027-11-10T00:00Z \
  --https-only \
  --output tsv
```

Paste the output into **SAS token**, with or without the leading `?`. When the token expires, tests and exports fail with `AuthenticationFailed`, so edit the provider and paste a new token before then.

## Fix a Failed Connection Test

A failed test names what went wrong and, where the error makes it clear, what to change. Find the message below.

:::tabs
@tab AWS
| Message contains | Fix |
| --- | --- |
| `AccessDenied` | The identity cannot write under the key prefix. Attach the [bucket policy](#grant-bucket-access) for that prefix. A bucket encrypted with a KMS key also needs `kms:GenerateDataKey` on that key. |
| `Could not assume` | The role's trust policy does not allow the source identity, the external ID does not match, or the source lacks `sts:AssumeRole` on the role. |
| `does not exist` | The bucket name is wrong, or the custom endpoint points at another store. |
| `is not in` | Set **Region** to the bucket's region. The message names it when S3 reports it. |
| `No AWS credentials found` | The default chain found no AWS identity. Annotate the service account, or choose another authentication method. |
| `InvalidAccessKeyId` or `SignatureDoesNotMatch` | The stored access key is wrong or deactivated. Paste it again. |
| `ExpiredToken` | The session token expired. Store fresh credentials, or use a role instead. |
@tab Google Cloud
| Message contains | Fix |
| --- | --- |
| `was not found` | The bucket name is wrong. |
| `Grant it roles/storage.objectUser` | The identity has no object access on the bucket. [Grant it](#set-up-google-cloud-storage). |
| `Google rejected the service account key` | The key was deleted or disabled. Create a new key and paste it. |
| `Google rejected the credentials` | Google refused the identity. Paste the key again, or check the Workload Identity binding. |
| `No Application Default Credentials found` | The pods have no Google identity. Set up Workload Identity, attach a service account, or switch to **Service account key**. |
@tab Azure
| Message contains | Fix |
| --- | --- |
| `does not exist in storage account` | Create the container, or fix the **Storage account** or **Container** name. |
| `AuthorizationPermissionMismatch` | [Assign Storage Blob Data Contributor](#grant-container-access), then wait a few minutes. For a SAS token, issue one with `cwd`. |
| `AuthorizationFailure` | The same fix, or the storage account's firewall blocks Archestra's network. |
| `AuthenticationFailed` | The SAS token expired or was signed for another account or container, or the account key is wrong. Paste a new one. |
| `Could not resolve` | The storage account name or the custom endpoint is wrong. |
| `No Azure credential found` | The pods have no Azure identity. Set up Workload Identity or a managed identity, or pick another authentication method. |
| `Microsoft Entra sign-in failed` | The tenant ID, client ID, or client secret is wrong, or the secret expired. The `AADSTS` code in the message says which. |
:::

`could not reach the storage endpoint`, with any provider, means the network failed: check the endpoint, DNS, and egress rules.

What to know:

- A failed scheduled export shows the same message on its row in **Costs > Exports**.
- A test runs on a web pod and exports run on a worker pod. When tests pass and exports fail, check that the worker pods sign in as the same identity.
