import JSZip from "jszip";
import { describe, expect, test } from "@/test";
import { extractTextFromXlsx } from "./xlsx-text-extractor";

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function buildXlsx(params: {
  sharedStrings?: string[];
  cells?: string;
}): Promise<Buffer> {
  const zip = new JSZip();
  if (params.sharedStrings) {
    const sst = params.sharedStrings
      .map((s) => `<si><t>${xmlEscape(s)}</t></si>`)
      .join("");
    zip.file(
      "xl/sharedStrings.xml",
      `<?xml version="1.0"?><sst xmlns="${SHEET_NS}">${sst}</sst>`,
    );
  }
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData><row>${params.cells ?? ""}</row></sheetData></worksheet>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("extractTextFromXlsx", () => {
  test("reads shared-string cells via their index", async () => {
    const buffer = await buildXlsx({
      sharedStrings: ["Revenue", "Q1 2024"],
      cells: `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>`,
    });
    expect(await extractTextFromXlsx(buffer)).toBe("Revenue Q1 2024");
  });

  test("reads inline strings and raw numeric values", async () => {
    const buffer = await buildXlsx({
      cells: `<c r="A1" t="inlineStr"><is><t>Inline</t></is></c><c r="B1"><v>42</v></c>`,
    });
    expect(await extractTextFromXlsx(buffer)).toBe("Inline 42");
  });

  test("concatenates rich-text runs within one shared string", async () => {
    const zip = new JSZip();
    zip.file(
      "xl/sharedStrings.xml",
      `<?xml version="1.0"?><sst xmlns="${SHEET_NS}"><si><r><t>Hello </t></r><r><t>World</t></r></si></sst>`,
    );
    zip.file(
      "xl/worksheets/sheet1.xml",
      `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData><row><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    );
    const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    expect(await extractTextFromXlsx(buffer)).toBe("Hello World");
  });

  test("returns cell text verbatim, without leaking or mangling markup", async () => {
    // A cell whose content looks like an HTML tag is stored entity-encoded in
    // the XML; a real parser returns it as literal text. (The old regex
    // tag-stripping was flagged by CodeQL as incomplete sanitization.)
    const buffer = await buildXlsx({
      sharedStrings: ["<script>alert(1)</script>"],
      cells: `<c r="A1" t="s"><v>0</v></c>`,
    });
    expect(await extractTextFromXlsx(buffer)).toBe("<script>alert(1)</script>");
  });

  test("returns an empty string for a non-ZIP buffer", async () => {
    expect(await extractTextFromXlsx(Buffer.from("not a zip"))).toBe("");
  });
});
