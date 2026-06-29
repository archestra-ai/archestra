import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { extractTextFromDocx } from "./docx-text-extractor";

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const WORD_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

async function buildDocx(bodyContent: string): Promise<Buffer> {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${bodyContent}</w:body>
</w:document>`;

  const zip = new JSZip();
  zip.file("[Content_Types].xml", CONTENT_TYPES);
  zip.file("_rels/.rels", RELS);
  zip.file("word/_rels/document.xml.rels", WORD_RELS);
  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "nodebuffer" }) as Promise<Buffer>;
}

describe("extractTextFromDocx", () => {
  it("extracts text from a single paragraph", async () => {
    const buffer = await buildDocx(
      "<w:p><w:r><w:t>Hello, world!</w:t></w:r></w:p>",
    );
    expect(await extractTextFromDocx(buffer)).toContain("Hello, world!");
  });

  it("extracts multiple paragraphs", async () => {
    const buffer = await buildDocx(
      "<w:p><w:r><w:t>First.</w:t></w:r></w:p><w:p><w:r><w:t>Second.</w:t></w:r></w:p>",
    );
    const text = await extractTextFromDocx(buffer);
    expect(text).toContain("First.");
    expect(text).toContain("Second.");
  });

  it("concatenates multiple runs", async () => {
    const buffer = await buildDocx(
      "<w:p><w:r><w:t>Hello, </w:t></w:r><w:r><w:t>world!</w:t></w:r></w:p>",
    );
    expect(await extractTextFromDocx(buffer)).toContain("Hello, world!");
  });

  it("returns empty string for empty body", async () => {
    const buffer = await buildDocx("");
    expect((await extractTextFromDocx(buffer)).trim()).toBe("");
  });

  it("throws for invalid buffer", async () => {
    await expect(
      extractTextFromDocx(Buffer.from("not a docx")),
    ).rejects.toThrow();
  });
});
