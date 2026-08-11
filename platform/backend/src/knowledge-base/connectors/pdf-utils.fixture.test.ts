import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describePdfEmptyText, parsePdfBuffer } from "./pdf-utils";

// A real image-only PDF — the scanned-document shape from issue #7157: one
// page, valid structure, no text layer. Generated on macOS from a 1×1 PNG with
// `sips -s format pdf px.png --out scanned-no-text-layer.pdf`.
//
// pdf-utils.test.ts mocks the bundled pdf.js boundary to pin page outcomes;
// this file keeps it real so the no_text_layer classification is proven
// against an actual scan-like PDF. The bundled 2018 pdf.js build is only reliable for a
// single in-process parse of a given buffer, so this file performs exactly one
// parse — don't add more PDF cases here.

describe("parsePdfBuffer with a real scanned PDF", () => {
  it("classifies an image-only PDF as no_text_layer", async () => {
    const buffer = readFileSync(
      join(__dirname, "__fixtures__", "scanned-no-text-layer.pdf"),
    );

    const result = await parsePdfBuffer(buffer);

    expect(result).toEqual({
      text: "",
      status: "no_text_layer",
      pageCount: 1,
      imageOnlyPageCount: 1,
    });
    expect(describePdfEmptyText(result)).toContain("no extractable text layer");
  });
});
