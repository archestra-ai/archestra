import { z } from "zod";

/**
 * Blob providers: organization-level object storage destinations (an S3
 * bucket, a Google Cloud Storage bucket, an Azure Blob Storage container) that
 * features write files to, such as scheduled cost exports. One provider is
 * configured once and reused by every feature that exports.
 */

export const BlobProviderTypeSchema = z.enum(["s3", "gcs", "azure_blob"]);
export type BlobProviderType = z.infer<typeof BlobProviderTypeSchema>;

export const BLOB_PROVIDER_TYPE_LABELS: Record<BlobProviderType, string> = {
  s3: "Amazon S3",
  gcs: "Google Cloud Storage",
  azure_blob: "Azure Blob Storage",
};

/**
 * How Archestra authenticates to S3:
 * - `default_chain`: the AWS SDK default credential chain of the Archestra
 *   process (environment variables, IRSA / EKS Pod Identity web identity
 *   tokens, ECS task role, EC2 instance profile, shared config files).
 * - `access_key`: a static access key ID and secret access key (optionally
 *   with a session token), stored in the secrets manager.
 * - `assume_role`: STS AssumeRole into a role ARN (optionally with an
 *   external ID), using the default chain — or a stored access key, when one
 *   is set — as the source identity.
 */
export const S3AuthMethodSchema = z.enum([
  "default_chain",
  "access_key",
  "assume_role",
]);
export type S3AuthMethod = z.infer<typeof S3AuthMethodSchema>;

export const S3_AUTH_METHOD_LABELS: Record<S3AuthMethod, string> = {
  default_chain: "AWS default credential chain",
  access_key: "Access key",
  assume_role: "Assume IAM role",
};

/**
 * How Archestra authenticates to Google Cloud Storage:
 * - `application_default`: Application Default Credentials of the Archestra
 *   process (GKE Workload Identity, an attached service account,
 *   `GOOGLE_APPLICATION_CREDENTIALS`).
 * - `service_account_key`: a service account JSON key, stored in the secrets
 *   manager.
 */
export const GcsAuthMethodSchema = z.enum([
  "application_default",
  "service_account_key",
]);
export type GcsAuthMethod = z.infer<typeof GcsAuthMethodSchema>;

export const GCS_AUTH_METHOD_LABELS: Record<GcsAuthMethod, string> = {
  application_default: "Application Default Credentials",
  service_account_key: "Service account key",
};

/**
 * How Archestra authenticates to Azure Blob Storage:
 * - `default_credential`: the Azure SDK default credential of the Archestra
 *   process (AKS Workload Identity, managed identity, environment variables).
 * - `service_principal`: a Microsoft Entra app registration's client secret.
 * - `account_key`: a storage account access key.
 * - `sas_token`: a shared access signature scoped to the container.
 * Every secret is stored in the secrets manager.
 */
export const AzureBlobAuthMethodSchema = z.enum([
  "default_credential",
  "service_principal",
  "account_key",
  "sas_token",
]);
export type AzureBlobAuthMethod = z.infer<typeof AzureBlobAuthMethodSchema>;

export const AZURE_BLOB_AUTH_METHOD_LABELS: Record<
  AzureBlobAuthMethod,
  string
> = {
  default_credential: "Azure default credential",
  service_principal: "Service principal",
  account_key: "Storage account key",
  sas_token: "SAS token",
};

/** How often a cost export writes a file. */
export const CostExportScheduleSchema = z.enum(["hourly", "daily"]);
export type CostExportSchedule = z.infer<typeof CostExportScheduleSchema>;

/** File format of a cost export. */
export const CostExportFormatSchema = z.enum(["focus_csv"]);
export type CostExportFormat = z.infer<typeof CostExportFormatSchema>;

export const COST_EXPORT_FORMAT_LABELS: Record<CostExportFormat, string> = {
  focus_csv: "FOCUS 1.2 (CSV)",
};
