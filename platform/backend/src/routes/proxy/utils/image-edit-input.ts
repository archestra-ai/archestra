import { createHash } from "node:crypto";
import sharp from "sharp";
import { ApiError } from "@/types/api";

export const IMAGE_EDIT_MAX_FILE_BYTES = 50 * 1024 * 1024 - 1;
export const IMAGE_EDIT_MAX_MASK_BYTES = 4 * 1024 * 1024 - 1;

export interface ImageEditFile {
  fieldname: string;
  filename: string;
  mimetype: string;
  data: Buffer;
}

export interface ValidatedImageEditUploads {
  images: ImageEditFile[];
  mask?: ImageEditFile;
  metadata: {
    images: ImageEditFileMetadata[];
    mask?: ImageEditFileMetadata;
  };
}

/** Decode for validation only; the original upload bytes are forwarded unchanged. */
export async function validateImageEditUploads(
  files: ImageEditFile[],
): Promise<ValidatedImageEditUploads> {
  if (
    files.some((file) => !["image", "image[]", "mask"].includes(file.fieldname))
  ) {
    throw new ApiError(400, "Image editing accepts only image and mask files.");
  }
  const images = files.filter((file) => file.fieldname !== "mask");
  const masks = files.filter((file) => file.fieldname === "mask");
  if (images.length < 1 || images.length > 16) {
    throw new ApiError(
      400,
      "Image editing requires between 1 and 16 input images.",
    );
  }
  if (masks.length > 1) throw new ApiError(400, "Only one mask is supported.");

  const metadata: ValidatedImageEditUploads["metadata"] = { images: [] };
  for (const file of images)
    metadata.images.push(await validateImage(file, false));
  const mask = masks[0];
  if (mask) {
    metadata.mask = await validateImage(mask, true);
    const first = metadata.images[0];
    if (
      metadata.mask.width !== first.width ||
      metadata.mask.height !== first.height
    ) {
      throw new ApiError(
        400,
        "The mask must have the same dimensions as the first input image.",
      );
    }
  }
  return { images, ...(mask && { mask }), metadata };
}

interface ImageEditFileMetadata {
  filename: string;
  mime_type: "image/png" | "image/jpeg";
  bytes: number;
  width: number;
  height: number;
  sha256: string;
}

const MAX_IMAGE_PIXELS = 16_777_216;

async function validateImage(
  file: ImageEditFile,
  mask: boolean,
): Promise<ImageEditFileMetadata> {
  if (!file.data.length)
    throw new ApiError(400, "Image files must not be empty.");
  if (
    file.data.length >
    (mask ? IMAGE_EDIT_MAX_MASK_BYTES : IMAGE_EDIT_MAX_FILE_BYTES)
  ) {
    throw new ApiError(
      413,
      mask
        ? "Masks must be smaller than 4 MiB."
        : "Input images must be smaller than 50 MiB.",
    );
  }
  const png = file.data
    .subarray(0, 8)
    .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg =
    file.data[0] === 255 && file.data[1] === 216 && file.data[2] === 255;
  if ((!png && !jpeg) || (mask && !png)) {
    throw new ApiError(
      400,
      mask
        ? "The mask must be a PNG image."
        : "Azure image inputs must be PNG or JPEG images.",
    );
  }
  const mime = png ? "image/png" : "image/jpeg";
  const declared = file.mimetype.split(";")[0].trim().toLowerCase();
  // SDK uploads created from a byte buffer commonly use application/octet-stream.
  if (
    declared &&
    declared !== "application/octet-stream" &&
    declared !== mime
  ) {
    throw new ApiError(
      400,
      "The uploaded image content does not match its MIME type.",
    );
  }
  try {
    const image = sharp(file.data, {
      limitInputPixels: MAX_IMAGE_PIXELS,
      failOn: "truncated",
    });
    const info = await image.metadata();
    if (
      !info.width ||
      !info.height ||
      (info.pages ?? 1) !== 1 ||
      (info.format !== "png" && info.format !== "jpeg")
    ) {
      throw new Error("Invalid image metadata");
    }
    if (mask && !info.hasAlpha)
      throw new ApiError(400, "The PNG mask must have an alpha channel.");
    const stats = await image.stats();
    if (mask && stats.channels.at(-1)?.min !== 0) {
      throw new ApiError(
        400,
        "The mask must include fully transparent pixels to edit.",
      );
    }
    return {
      filename: file.filename,
      mime_type: mime,
      bytes: file.data.length,
      width: info.width,
      height: info.height,
      sha256: createHash("sha256").update(file.data).digest("hex"),
    };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      400,
      "Invalid or truncated image, or image exceeds the 16 megapixel input limit.",
    );
  }
}
