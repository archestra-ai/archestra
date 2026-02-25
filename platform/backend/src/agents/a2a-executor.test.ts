import { describe, expect, test } from "vitest";
import { type A2AAttachment, buildUserContent } from "./a2a-executor";

describe("buildUserContent", () => {
  test("returns null when no attachments are provided", () => {
    expect(buildUserContent("Hello")).toBeNull();
  });

  test("returns null when attachments array is empty", () => {
    expect(buildUserContent("Hello", [])).toBeNull();
  });

  test("returns null when attachments contain no images", () => {
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
    expect(buildUserContent("Hello", attachments)).toBeNull();
  });

  test("builds content parts with a single image attachment", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: "iVBORw0KGgo=",
        name: "photo.png",
      },
    ];

    const result = buildUserContent("Describe this image", attachments);

    expect(result).toEqual([
      { type: "text", text: "Describe this image" },
      { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
  });

  test("builds content parts with multiple image attachments", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: "cG5nZGF0YQ==",
        name: "image1.png",
      },
      {
        contentType: "image/jpeg",
        contentBase64: "/9j/4AAQ",
        name: "image2.jpg",
      },
    ];

    const result = buildUserContent("What's in these photos?", attachments);

    expect(result).toEqual([
      { type: "text", text: "What's in these photos?" },
      { type: "image", image: "data:image/png;base64,cG5nZGF0YQ==" },
      { type: "image", image: "data:image/jpeg;base64,/9j/4AAQ" },
    ]);
  });

  test("filters out non-image attachments from mixed set", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "application/pdf",
        contentBase64: "JVBERi0xLjQ=",
        name: "doc.pdf",
      },
      {
        contentType: "image/png",
        contentBase64: "iVBORw0KGgo=",
        name: "photo.png",
      },
      {
        contentType: "text/plain",
        contentBase64: "SGVsbG8=",
        name: "note.txt",
      },
    ];

    const result = buildUserContent("Check this", attachments);

    expect(result).toEqual([
      { type: "text", text: "Check this" },
      { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
  });

  test("handles various image MIME types", () => {
    const attachments: A2AAttachment[] = [
      { contentType: "image/png", contentBase64: "cG5n", name: "a.png" },
      { contentType: "image/jpeg", contentBase64: "anBl", name: "b.jpg" },
      { contentType: "image/gif", contentBase64: "Z2lm", name: "c.gif" },
      { contentType: "image/webp", contentBase64: "d2Vi", name: "d.webp" },
      { contentType: "image/svg+xml", contentBase64: "c3Zn", name: "e.svg" },
    ];

    const result = buildUserContent("Describe", attachments);

    expect(result).toHaveLength(6); // 1 text + 5 images
    expect(result![0]).toEqual({ type: "text", text: "Describe" });
    for (let i = 1; i < result!.length; i++) {
      expect(result![i]).toHaveProperty("type", "image");
    }
  });

  test("works with attachments that have no name", () => {
    const attachments: A2AAttachment[] = [
      {
        contentType: "image/png",
        contentBase64: "iVBORw0KGgo=",
      },
    ];

    const result = buildUserContent("What is this?", attachments);

    expect(result).toEqual([
      { type: "text", text: "What is this?" },
      { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" },
    ]);
  });
});
