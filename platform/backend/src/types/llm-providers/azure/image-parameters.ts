import { z } from "zod";

// Family-specific limits are checked using provider evidence, not an Azure alias.
const imageSize = z.string().regex(/^(auto|[1-9]\d{0,4}x[1-9]\d{0,4})$/);
const imageQuality = z.enum([
  "auto",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "standard",
  "hd",
]);
const imageOptions = {
  size: imageSize.nullish(),
  quality: imageQuality.nullish(),
  background: z.enum(["auto", "transparent", "opaque"]).nullish(),
  output_format: z.enum(["png", "jpeg", "webp"]).nullish(),
  response_format: z.enum(["url", "b64_json"]).nullish(),
  user: z.string().optional(),
  safety_identifier: z.string().nullish(),
};

/** Completed image responses only; unsupported fields must never disappear. */
export const ImageGenerationRequestSchema = z.strictObject({
  model: z.string().min(1),
  prompt: z.string().min(1),
  ...imageOptions,
  n: z.number().int().min(1).max(10).nullish(),
  output_compression: z.number().int().min(0).max(100).nullish(),
  moderation: z.enum(["auto", "low"]).nullish(),
  style: z.enum(["vivid", "natural"]).nullish(),
  stream: z.literal(false).nullish(),
});

/** Scalar multipart fields. Images and masks are validated by the handler. */
export const ImageEditFieldsSchema = z.strictObject({
  model: z.string().min(1),
  prompt: z.string().min(1),
  ...imageOptions,
  n: z.coerce.number().int().min(1).max(10).nullish(),
  output_compression: z.coerce.number().int().min(0).max(100).nullish(),
  input_fidelity: z.enum(["high", "low"]).nullish(),
  stream: z.preprocess(
    (value) => (value === "false" ? false : value),
    z.literal(false).nullish(),
  ),
});
