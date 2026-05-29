import { z } from "zod";

export const UploadedFileProcessingStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "failed",
]);
export type UploadedFileProcessingStatus = z.infer<
  typeof UploadedFileProcessingStatusSchema
>;
