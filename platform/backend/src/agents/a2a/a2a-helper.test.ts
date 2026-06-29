import type { WithImplicitCoercion } from "node:buffer";
import { describe, expect, test } from "@/test";
import { buildAttachmentsMessageParts } from "./a2a-helper";

describe("buildAttachmentsMessageParts", () => {
  test("empty", () => {
    const parts = buildAttachmentsMessageParts([]);
    expect(parts).toHaveLength(0);
  });

  test("maps every attachment to a protocol part, preserving mediaType, bytes and filename", () => {
    const imageBase64 = "A".repeat(2732);
    const pdfBase64 = Buffer.from("%PDF-1.4", "utf8").toString("base64");

    const parts = buildAttachmentsMessageParts([
      {
        contentType: "application/pdf",
        contentBase64: pdfBase64,
        name: "doc.pdf",
      },
      {
        contentType: "image/png",
        contentBase64: imageBase64,
        name: "image.png",
      },
    ]);

    // Type/capability filtering happens later in the executor, so this is a
    // straight byte mapping that keeps both attachments.
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({
      mediaType: "application/pdf",
      filename: "doc.pdf",
    });
    expect(parts[1]).toMatchObject({
      mediaType: "image/png",
      filename: "image.png",
    });
    expect(
      Buffer.from(parts[0].raw as WithImplicitCoercion<Buffer>).toString(
        "base64",
      ),
    ).toBe(pdfBase64);
    expect(
      Buffer.from(parts[1].raw as WithImplicitCoercion<Buffer>).toString(
        "base64",
      ),
    ).toBe(imageBase64);
  });
});
