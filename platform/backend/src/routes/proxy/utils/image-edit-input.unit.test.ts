import sharp from "sharp";
import { describe, expect, test } from "vitest";
import {
  loggedUploadMetadata,
  validateImageEditUploads,
} from "./image-edit-input";
import { LOGGED_MEDIA_MAX_BYTES } from "./logged-media";

async function image(fieldname = "image[]", width = 16, alpha = 0) {
  return {
    fieldname,
    filename: "reference.png",
    mimetype: "application/octet-stream",
    data: await sharp({
      create: {
        width,
        height: 16,
        channels: 4,
        background: { r: 5, g: 10, b: 15, alpha },
      },
    })
      .png()
      .toBuffer(),
  };
}

describe("image edit uploads", () => {
  test("preserves ordered SDK image buffers and one transparent mask while recording only metadata", async () => {
    const first = await image();
    const second = await image("image", 32);
    const mask = await image("mask");
    const result = await validateImageEditUploads([first, mask, second]);
    expect(result.images).toEqual([first, second]);
    expect(result.images[0].data).toBe(first.data);
    expect(result.mask?.data).toBe(mask.data);
    expect(result.metadata.images[0]).toMatchObject({
      mime_type: "image/png",
      width: 16,
      height: 16,
      bytes: first.data.length,
    });
    expect(JSON.stringify(result.metadata)).not.toContain(
      first.data.toString("base64"),
    );
    expect(result.metadata.images[0].sha256).toHaveLength(64);
  });

  test("keeps each upload and the mask for the log row, and marks one past the limit", async () => {
    const first = await image();
    const mask = await image("mask");
    const uploads = await validateImageEditUploads([first, mask]);
    const large = Buffer.alloc(LOGGED_MEDIA_MAX_BYTES + 1);
    const logged = loggedUploadMetadata({
      ...uploads,
      images: [...uploads.images, { ...first, data: large }],
      metadata: {
        ...uploads.metadata,
        images: [...uploads.metadata.images, uploads.metadata.images[0]],
      },
    });
    expect(logged.images[0]).toMatchObject({
      filename: "reference.png",
      data: first.data.toString("base64"),
    });
    expect(logged.images[1]).toMatchObject({ data_omitted: "too_large" });
    expect(logged.images[1]).not.toHaveProperty("data");
    expect(logged.mask).toMatchObject({ data: mask.data.toString("base64") });
    // What the provider and plugins see stays metadata only.
    expect(JSON.stringify(uploads.metadata)).not.toContain(
      first.data.toString("base64"),
    );
  });

  test("accepts JPEG input without reencoding it", async () => {
    const file = await image("image");
    file.data = await sharp(file.data).jpeg().toBuffer();
    file.mimetype = "image/jpeg";
    const result = await validateImageEditUploads([file]);
    expect(result.images[0].data).toBe(file.data);
    expect(result.metadata.images[0].mime_type).toBe("image/jpeg");
  });

  test("accepts an image part sent without its own content type", async () => {
    // The multipart parser reports such a part as text/plain; Python
    // `requests` uploads files that way by default, and OpenAI accepts them.
    const file = { ...(await image("image")), mimetype: "text/plain" };
    const result = await validateImageEditUploads([file]);
    expect(result.metadata.images[0].mime_type).toBe("image/png");
  });

  test("rejects invalid file counts, duplicate masks, unsupported file fields and empty files", async () => {
    const file = await image();
    await expect(validateImageEditUploads([])).rejects.toThrow(
      "between 1 and 16",
    );
    await expect(
      validateImageEditUploads(Array(17).fill(file)),
    ).rejects.toThrow("between 1 and 16");
    await expect(
      validateImageEditUploads([
        file,
        await image("mask"),
        await image("mask"),
      ]),
    ).rejects.toThrow("Only one mask");
    await expect(
      validateImageEditUploads([{ ...file, fieldname: "file" }]),
    ).rejects.toThrow("only image and mask");
    await expect(
      validateImageEditUploads([{ ...file, data: Buffer.alloc(0) }]),
    ).rejects.toThrow("must not be empty");
  });

  test("rejects false MIME declarations, unsupported formats, truncated images and oversized masks", async () => {
    const file = await image();
    await expect(
      validateImageEditUploads([{ ...file, mimetype: "image/jpeg" }]),
    ).rejects.toThrow("MIME type");
    await expect(
      validateImageEditUploads([
        { ...file, data: await sharp(file.data).gif().toBuffer() },
      ]),
    ).rejects.toThrow("PNG, JPEG, or WebP");
    await expect(
      validateImageEditUploads([{ ...file, data: file.data.subarray(0, 40) }]),
    ).rejects.toThrow("Invalid or truncated");
    await expect(
      validateImageEditUploads([
        file,
        { ...file, fieldname: "mask", data: Buffer.alloc(4 * 1024 * 1024) },
      ]),
    ).rejects.toThrow("smaller than 4 MiB");
  });

  test("requires a same-dimension PNG mask with transparent editable pixels", async () => {
    const file = await image();
    await expect(
      validateImageEditUploads([file, await image("mask", 32)]),
    ).rejects.toThrow("same dimensions");
    await expect(
      validateImageEditUploads([file, await image("mask", 16, 1)]),
    ).rejects.toThrow("fully transparent");
    const mask = await image("mask");
    mask.data = await sharp(mask.data).removeAlpha().png().toBuffer();
    await expect(validateImageEditUploads([file, mask])).rejects.toThrow(
      "alpha channel",
    );
  });
});
