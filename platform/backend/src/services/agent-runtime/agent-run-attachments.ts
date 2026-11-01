import { z } from "zod";
import config from "@/config";

export function agentRunAttachmentsSchema() {
  return z
    .array(
      z
        .object({
          name: z.string().trim().min(1).max(255),
          contentType: z.string().trim().min(1).max(255),
          contentBase64: z
            .string()
            .min(1)
            .refine(
              isCanonicalBase64,
              "Attachment content is not valid base64",
            ),
        })
        .superRefine((attachment, context) => {
          const bytes = Buffer.from(attachment.contentBase64, "base64");
          if (bytes.byteLength === 0) {
            context.addIssue({
              code: "custom",
              message: "Attachment content is not valid base64",
            });
          }
          if (bytes.byteLength > config.chat.attachmentStorageBytesLimit) {
            context.addIssue({
              code: "custom",
              message: `Attachments may not exceed ${config.chat.attachmentStorageBytesLimit} bytes`,
            });
          }
        }),
    )
    .max(20)
    .optional();
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}
