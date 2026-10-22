import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiError, Azure } from "@/types";
import {
  type AzureImageEditRequest,
  createAzureImageEditAdapter,
} from "./adapters/azure-image-edits";
import { PROXY_BODY_LIMIT } from "./common";
import { handleLLMProxy } from "./llm-proxy-handler";
import { getAzureProxyIngress } from "./utils/azure-ingress";
import {
  IMAGE_EDIT_MAX_FILE_BYTES,
  type ValidatedImageEditUploads,
  validateImageEditUploads,
} from "./utils/image-edit-input";
import { parseMediaMultipart } from "./utils/media-multipart";

export interface ParsedAzureImageEdit {
  body: AzureImageEditRequest;
  uploads: ValidatedImageEditUploads;
}

// Runtime validation happens after the private bounded multipart parser; this
// describes the actual wire body without putting upload bytes in request.body.
export const ImageEditMultipartBodySchema = z.unknown().meta({
  type: "object",
  properties: {
    ...z.toJSONSchema(Azure.API.ImageEditFieldsSchema, {
      unrepresentable: "any",
    }).properties,
    image: {
      type: "array",
      items: { type: "string", format: "binary" },
      minItems: 1,
      maxItems: 16,
      description: "PNG/JPEG/WebP reference files, each smaller than 50 MiB.",
    },
    mask: {
      type: "string",
      format: "binary",
      description:
        "Optional PNG alpha mask smaller than 4 MiB, matching the first image dimensions.",
    },
  },
  required: ["model", "prompt", "image"],
});

export async function parseAzureImageEditRequest(
  request: FastifyRequest,
): Promise<ParsedAzureImageEdit> {
  const { fields, files } = await parseMediaMultipart(request, {
    fileFields: ["image", "mask"],
    arrayFields: ["image"],
    maxFiles: 17,
    maxFileBytes: IMAGE_EDIT_MAX_FILE_BYTES,
    maxTotalFileBytes: PROXY_BODY_LIMIT,
    maxFields: 20,
    maxFieldBytes: 128 * 1024,
    maxParts: 37,
  });
  const deployment = getAzureProxyIngress(request)?.deployment;
  if (deployment) fields.model = deployment;
  const result = Azure.API.ImageEditFieldsSchema.safeParse(fields);
  if (!result.success)
    throw new ApiError(
      400,
      "Invalid image edit fields. Use supported scalar parameters, stream: false, and multipart image files.",
    );
  const uploads = await validateImageEditUploads(files);
  return {
    body: {
      ...result.data,
      input_files: uploads.metadata,
      metadata: { operation: "image-edit" },
    },
    uploads,
  };
}

/** The caller may install a trusted router auth override before execution. */
export function handleAzureImageEdit(
  parsed: ParsedAzureImageEdit,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  request.body = parsed.body;
  return handleLLMProxy(
    parsed.body,
    request,
    reply,
    createAzureImageEditAdapter(parsed.uploads),
  );
}
