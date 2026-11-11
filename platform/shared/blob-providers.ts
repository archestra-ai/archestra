import { z } from "zod";

/**
 * Blob providers: organization-level object storage destinations (an S3
 * bucket today) that features write files to, such as scheduled cost exports.
 * One provider is configured once and reused by every feature that exports.
 */

export const BlobProviderTypeSchema = z.enum(["s3"]);
export type BlobProviderType = z.infer<typeof BlobProviderTypeSchema>;

export const BLOB_PROVIDER_TYPE_LABELS: Record<BlobProviderType, string> = {
  s3: "Amazon S3 (or S3-compatible)",
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
  default_chain: "AWS default credential chain (IAM role, IRSA, env vars)",
  access_key: "Access key",
  assume_role: "Assume IAM role",
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
