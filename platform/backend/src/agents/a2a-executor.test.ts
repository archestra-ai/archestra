import { describe, expect, test } from "vitest";
import { MIN_IMAGE_ATTACHMENT_SIZE } from "@/agents/incoming-email/constants";
import { type A2AAttachment, buildUserContent } from "./a2a-executor";

// Base64 string large enough to pass the MIN_IMAGE_ATTACHMENT_SIZE (2KB) filter.
// 2732 base64 chars → ~2048 decoded bytes.
const VALID_IMAGE_BASE64 = "A".repeat(2732);

describe("buildUserContent", () => {
  test("returns null content when no attachments are provided", () => {
    const { content, skippedNote } = buildUserContent("Hello");
    expect(content).toBeNull();
    expect(skippedNote).toBe("");
  });

  test("returns null content when attachments array is empty", () => {
    const { content, skippedNote } = buildUserContent("Hello", []);
    expect(content).toBeNull();
    expect(skippedNote).toBe("");
  });

  test("returns null content with skipped note when attachments contain no images", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/pdf",
        contentBase64: "JVBERi0xLjQ=",
        name: "doc.pdf",
      },
      {
        contentType: "text/plain",
        contentBase64: "SGVsbG8=",
        name: "note.txt",
      },
    ];
    const { content, skippedNote } = buildUserContent("Hello", attachments);
    expect(content).toBeNull();
    expect(skippedNote).toContain("2 attachment(s)");
    expect(skippedNote).toContain("doc.pdf (application/pdf)");
    expect(skippedNote).toContain("note.txt (text/plain)");
  });

  test("builds content parts with a single image attachment", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: VALID_IMAGE_BASE64,
        name: "photo.png",
      },
    ];

    const { content } = buildUserContent("Describe this image", attachments);

    expect(content).toEqual([
      { type: "text", text: "Describe this image" },
      { type: "image", image: `data:image/png;base64,${VALID_IMAGE_BASE64}` },
    ]);
  });

  test("builds content parts with multiple image attachments", () => {
    const pngBase64 = "B".repeat(3000);
    const jpegBase64 = "C".repeat(3000);
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: pngBase64,
        name: "image1.png",
      },
      {
        contentType: "image/jpeg",
        contentBase64: jpegBase64,
        name: "image2.jpg",
      },
    ];

    const { content } = buildUserContent(
      "What's in these photos?",
      attachments,
    );

    expect(content).toEqual([
      { type: "text", text: "What's in these photos?" },
      { type: "image", image: `data:image/png;base64,${pngBase64}` },
      { type: "image", image: `data:image/jpeg;base64,${jpegBase64}` },
    ]);
  });

  test("filters out non-image attachments from mixed set and appends note", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/pdf",
        contentBase64: "JVBERi0xLjQ=",
        name: "doc.pdf",
      },
      {
        contentType: "image/png",
        contentBase64: VALID_IMAGE_BASE64,
        name: "photo.png",
      },
      {
        contentType: "text/plain",
        contentBase64: "SGVsbG8=",
        name: "note.txt",
      },
    ];

    const { content, skippedNote } = buildUserContent(
      "Check this",
      attachments,
    );

    expect(content).toHaveLength(2); // 1 text + 1 image
    expect(content?.[0]).toHaveProperty("type", "text");
    // The text part should include the skipped note
    expect((content?.[0] as { text: string }).text).toContain("Check this");
    expect((content?.[0] as { text: string }).text).toContain(
      "2 attachment(s)",
    );
    expect(content?.[1]).toEqual({
      type: "image",
      image: `data:image/png;base64,${VALID_IMAGE_BASE64}`,
    });
    expect(skippedNote).toContain("doc.pdf");
    expect(skippedNote).toContain("note.txt");
  });

  test("handles various image MIME types", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: VALID_IMAGE_BASE64,
        name: "a.png",
      },
      {
        contentType: "image/jpeg",
        contentBase64: VALID_IMAGE_BASE64,
        name: "b.jpg",
      },
      {
        contentType: "image/gif",
        contentBase64: VALID_IMAGE_BASE64,
        name: "c.gif",
      },
      {
        contentType: "image/webp",
        contentBase64: VALID_IMAGE_BASE64,
        name: "d.webp",
      },
      {
        contentType: "image/svg+xml",
        contentBase64: VALID_IMAGE_BASE64,
        name: "e.svg",
      },
    ];

    const { content } = buildUserContent("Describe", attachments);

    expect(content).toHaveLength(6); // 1 text + 5 images
    expect(content?.[0]).toHaveProperty("type", "text");
    for (let i = 1; i < (content?.length ?? 0); i++) {
      expect(content?.[i]).toHaveProperty("type", "image");
    }
  });

  test("works with attachments that have no name", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: VALID_IMAGE_BASE64,
      },
    ];

    const { content } = buildUserContent("What is this?", attachments);

    expect(content).toEqual([
      { type: "text", text: "What is this?" },
      { type: "image", image: `data:image/png;base64,${VALID_IMAGE_BASE64}` },
    ]);
  });

  test("skipped note uses 'unnamed' for attachments without names", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/pdf",
        contentBase64: "JVBERi0xLjQ=",
      },
    ];

    const { skippedNote } = buildUserContent("Hello", attachments);

    expect(skippedNote).toContain("unnamed (application/pdf)");
  });

  test("filters out tiny image attachments below MIN_IMAGE_ATTACHMENT_SIZE", () => {
    // Create a tiny image (~988 bytes, like broken Outlook inline references)
    // Base64 length of ~1317 chars → ~988 decoded bytes (below 2KB threshold)
    const tinyBase64 = "A".repeat(1317);

    // Create a valid-sized image (above 2KB threshold)
    // Base64 length of ~2732 chars → ~2048 decoded bytes
    const validBase64 = "B".repeat(2732);

    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: tinyBase64,
        name: "broken-inline-ref.png",
      },
      {
        contentType: "image/jpeg",
        contentBase64: validBase64,
        name: "real-photo.jpg",
      },
    ];

    const { content, skippedNote } = buildUserContent(
      "Check this",
      attachments,
    );

    // Should include only the valid image
    expect(content).toHaveLength(2); // 1 text + 1 image
    expect(content?.[1]).toEqual({
      type: "image",
      image: `data:image/jpeg;base64,${validBase64}`,
    });

    // Skipped note should mention the filtered tiny image
    expect(skippedNote).toContain("broken-inline-ref.png");
    expect(skippedNote).toContain("1 attachment(s)");
  });

  test("returns null content when all images are below minimum size", () => {
    const tinyBase64 = "A".repeat(100); // ~75 bytes

    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: tinyBase64,
        name: "tiny.png",
      },
    ];

    const { content, skippedNote } = buildUserContent("Hello", attachments);

    expect(content).toBeNull();
    expect(skippedNote).toContain("tiny.png");
  });

  test("does not filter images at or above the minimum size threshold", () => {
    // Create an image exactly at the threshold (2048 bytes = MIN_IMAGE_ATTACHMENT_SIZE)
    // 2048 bytes → base64 length = ceil(2048 * 4/3) = 2731 chars
    const thresholdBase64 = "C".repeat(2731);
    const estimatedBytes = Math.ceil((2731 * 3) / 4);
    expect(estimatedBytes).toBeGreaterThanOrEqual(MIN_IMAGE_ATTACHMENT_SIZE);

    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: thresholdBase64,
        name: "threshold.png",
      },
    ];

    const { content } = buildUserContent("Test", attachments);

    expect(content).toHaveLength(2); // 1 text + 1 image
    expect(content?.[1]).toHaveProperty("type", "image");
  });
});
