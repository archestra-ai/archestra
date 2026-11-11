---
title: Blob Providers
description: Connect an S3 bucket or S3-compatible store once, so features that write files, such as scheduled cost exports, send them there
order: 6
lastUpdated: 2026-11-10
---

<!-- Renaming/deleting this file? Add a redirect in docs/redirects.json. -->

Connect your organization's bucket once, and Archestra features that write files send them there. A [scheduled cost export](/docs/llm-proxy/costs-and-limits/costs#export-costs-to-object-storage) picks the provider by name and never sees its keys, so nobody pastes AWS credentials into each feature.

A blob provider writes to Amazon S3 or to any S3-compatible store, such as MinIO, Cloudflare R2, or Ceph. Native Google Cloud Storage and Azure Blob Storage providers are not available; for Cloud Storage, use its [S3-compatible endpoint](#use-an-s3-compatible-store).

## Add a Blob Provider

Add one provider per bucket, and every feature that writes files can pick it. Viewing blob providers requires [`organizationSettings:read`](/docs/reference/permissions#organizationSettings:read). Adding, changing, testing, or deleting one requires [`organizationSettings:update`](/docs/reference/permissions#organizationSettings:update).

1. [Grant the bucket access](#grant-bucket-access) to the identity Archestra will use.
2. Open **Settings → Blob Providers** and add a provider.
3. Fill in the bucket:
   - **Name:** how features list this provider, such as `finops-bucket`. Names are unique in the organization.
   - **Bucket** and **Region:** the bucket name, without `s3://`, and its AWS region, such as `eu-west-1`.
   - **Key prefix:** an optional folder in the bucket. Every object Archestra writes, and its connection test, goes under it.
4. Choose an [auth method](#choose-how-archestra-signs-in) and fill in its fields.
5. Save the provider, then click **Test** on its row.

The test passes with "Wrote and deleted a test object." Any other message is the storage error. See [Fix a Failed Test](#fix-a-failed-test).

What to know:

- Access keys go to Archestra's [secret storage](/docs/admin/deployment/secret-storage) and are never shown again. Leave the fields empty when you edit a provider to keep the stored key.
- A provider's type cannot change after it is created. Add a new provider instead.
- A provider that a cost export uses cannot be deleted. Delete the export, or move it to another provider, first.

## Choose How Archestra Signs In

Archestra signs in to S3 in one of three ways. On AWS, prefer the pod's own identity: there is no key to store or rotate.

| Auth method | Use it when | You provide |
| --- | --- | --- |
| AWS default credential chain | Archestra runs on AWS with an IAM role: EKS (IRSA or EKS Pod Identity), ECS, or EC2. | Nothing. The role comes from the Archestra pods. |
| Assume IAM role | The bucket is in another AWS account, or you want a role used only for this bucket. | The role ARN and, if its trust policy requires one, an external ID. Optionally, an access key to assume the role with. |
| Access key | Archestra runs outside AWS, or the store is S3-compatible. | An access key ID and secret access key. A session token is optional. |

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

Archestra assumes the role through STS, signing in as the default chain's identity, or as the stored access key when you add one. Allow that identity in the role's trust policy, and require the external ID you enter on the provider:

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

## Grant Bucket Access

The identity needs to write objects under the provider's key prefix, and nothing else. Scheduled exports use `s3:PutObject`. The connection test also deletes its probe object, so it needs `s3:DeleteObject`:

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

## Use an S3-Compatible Store

Set **Endpoint** to the store's S3 API URL and turn on **Force path style**, which most S3-compatible stores require. Sign in with an access key from the store.

| Store | Endpoint |
| --- | --- |
| MinIO, Ceph, SeaweedFS | Your server's S3 URL, such as `https://minio.example.internal:9000` |
| Cloudflare R2 | `https://<account-id>.r2.cloudflarestorage.com`, with region `auto` |
| Google Cloud Storage | `https://storage.googleapis.com`, with an [HMAC key](https://cloud.google.com/storage/docs/authentication/hmackeys) as the access key |

**Region** is still required. Use the value the store documents for S3 clients.

The endpoint must start with `http://` or `https://`, and Archestra's pods must reach it over the network.

## Fix a Failed Test

A failed test shows the storage error code first, then its message.

| Test message starts with | Fix |
| --- | --- |
| `AccessDenied` | The identity cannot write under the key prefix. Check the [bucket policy](#grant-bucket-access) and its prefix. A bucket encrypted with a KMS key also needs `kms:GenerateDataKey` on that key. |
| `AccessDenied` and mentions `sts:AssumeRole` | The role's trust policy does not allow the source identity, or the external ID does not match. |
| `NoSuchBucket` | The bucket name is wrong, or the endpoint points at another store. |
| `PermanentRedirect` or `AuthorizationHeaderMalformed` | The region does not match the bucket's region. |
| `CredentialsProviderError` | The default chain found no AWS identity. Annotate the service account, or choose another auth method. |
| `InvalidAccessKeyId` or `SignatureDoesNotMatch` | The stored access key is wrong. Paste it again. |

A test that passes proves writes work from the web pods. When scheduled exports still fail, their error shows on the export's row: check that the worker pods run with the same identity.
