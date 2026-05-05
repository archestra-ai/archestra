import type { WithImplicitCoercion } from "node:buffer";
import { describe, expect, test } from "@/test";
import { buildAttachmentsMessageParts } from "./a2a-helper";

describe("buildAttachmentsMessageParts", () => {
  test("empty", () => {
    const parts = buildAttachmentsMessageParts([]);
    expect(parts).toHaveLength(0);
  });

  test("simple", () => {
    const imageBase64 = "A".repeat(2732);

    const parts = buildAttachmentsMessageParts([
      {
        contentType: "application/pdf",
        contentBase64: Buffer.from("%PDF-1.4", "utf8").toString("base64"),
        name: "doc.pdf",
      },
      {
        contentType: "image/png",
        contentBase64: imageBase64,
        name: "image.png",
      },
    ]);

    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      mediaType: "image/png",
    });
    expect(
      Buffer.from(parts[0].raw as WithImplicitCoercion<Buffer>).toString(
        "base64",
      ),
    ).toBe(imageBase64);
  });
});
