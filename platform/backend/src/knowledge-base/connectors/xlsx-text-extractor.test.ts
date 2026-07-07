import JSZip from "jszip";
import { describe, expect, test } from "@/test";
import { extractTextFromXlsx } from "./xlsx-text-extractor";

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL_NS =
  "http://schemas.openxmlformats.org/package/2006/relationships";

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 0-based column index → its letter ("A", "B", ... "AA"). */
function colLetter(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Minimal single-row .xlsx (no workbook metadata); caller supplies the cells. */
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
    `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData><row r="1">${params.cells ?? ""}</row></sheetData></worksheet>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

/** Build an .xlsx with named sheets (workbook.xml + rels), one row each. */
async function buildNamedXlsx(
  sheets: { name: string; cells: string[]; file?: string; rid?: string }[],
): Promise<Buffer> {
  const zip = new JSZip();
  const withMeta = sheets.map((s, i) => ({
    name: s.name,
    cells: s.cells,
    rid: s.rid ?? `rId${i + 1}`,
    file: s.file ?? `sheet${i + 1}.xml`,
  }));

  const sst = withMeta
    .flatMap((s) => s.cells)
    .map((c) => `<si><t>${xmlEscape(c)}</t></si>`)
    .join("");
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0"?><sst xmlns="${SHEET_NS}">${sst}</sst>`,
  );

  const sheetTags = withMeta
    .map(
      (s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="${s.rid}"/>`,
    )
    .join("");
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>${sheetTags}</sheets></workbook>`,
  );

  const relTags = withMeta
    .map(
      (s) =>
        `<Relationship Id="${s.rid}" Type="${REL_NS}/worksheet" Target="worksheets/${s.file}"/>`,
    )
    .join("");
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="${PKG_REL_NS}">${relTags}</Relationships>`,
  );

  let stringIndex = 0;
  for (const s of withMeta) {
    const row = s.cells
      .map(
        (_, c) => `<c r="${colLetter(c)}1" t="s"><v>${stringIndex++}</v></c>`,
      )
      .join("");
    zip.file(
      `xl/worksheets/${s.file}`,
      `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData><row r="1">${row}</row></sheetData></worksheet>`,
    );
  }
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

/** Build a one-sheet .xlsx from explicit rows keyed by column letter. */
async function buildGridXlsx(sheet: {
  name: string;
  rows: { r: number; cells: Record<string, string> }[];
}): Promise<Buffer> {
  const zip = new JSZip();
  const stringOf = new Map<string, number>();
  for (const row of sheet.rows) {
    for (const value of Object.values(row.cells)) {
      if (!stringOf.has(value)) stringOf.set(value, stringOf.size);
    }
  }
  const sst = [...stringOf.keys()]
    .map((v) => `<si><t>${xmlEscape(v)}</t></si>`)
    .join("");
  zip.file(
    "xl/sharedStrings.xml",
    `<?xml version="1.0"?><sst xmlns="${SHEET_NS}">${sst}</sst>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="${sheet.name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0"?><Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  );
  const rowsXml = sheet.rows
    .map((row) => {
      const cells = Object.entries(row.cells)
        .map(
          ([col, v]) =>
            `<c r="${col}${row.r}" t="s"><v>${stringOf.get(v)}</v></c>`,
        )
        .join("");
      return `<row r="${row.r}">${cells}</row>`;
    })
    .join("");
  zip.file(
    "xl/worksheets/sheet1.xml",
    `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData>${rowsXml}</sheetData></worksheet>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("extractTextFromXlsx", () => {
  test("lays out rows and columns as CSV under a titled header", async () => {
    // A header row plus two data rows; the last row omits column B (a gap), which
    // must still keep the Region value aligned under column C (an empty field).
    const buffer = await buildGridXlsx({
      name: "Budget",
      rows: [
        { r: 1, cells: { A: "Quarter", B: "Amount", C: "Region" } },
        { r: 2, cells: { A: "Q1", B: "100", C: "EMEA" } },
        { r: 3, cells: { A: "Q2", C: "APAC" } },
      ],
    });
    expect(await extractTextFromXlsx(buffer)).toBe(
      [
        "Sheet 1: Budget",
        "1,Quarter,Amount,Region",
        "2,Q1,100,EMEA",
        "3,Q2,,APAC",
      ].join("\n"),
    );
  });

  test("quotes cells containing commas or quotes (RFC 4180)", async () => {
    const buffer = await buildGridXlsx({
      name: "Notes",
      rows: [
        { r: 1, cells: { A: "Item", B: "Detail" } },
        { r: 2, cells: { A: "Widget", B: "red, large" } },
        { r: 3, cells: { A: 'The "best"', B: "ok" } },
      ],
    });
    expect(await extractTextFromXlsx(buffer)).toBe(
      [
        "Sheet 1: Notes",
        "1,Item,Detail",
        '2,Widget,"red, large"',
        '3,"The ""best""",ok',
      ].join("\n"),
    );
  });

  test("reads shared-string cells via their index", async () => {
    const buffer = await buildXlsx({
      sharedStrings: ["Revenue", "Q1 2024"],
      cells: `<c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c>`,
    });
    expect(await extractTextFromXlsx(buffer)).toBe(
      "Sheet 1\n1,Revenue,Q1 2024",
    );
  });

  test("reads inline strings and raw numeric values", async () => {
    const buffer = await buildXlsx({
      cells: `<c r="A1" t="inlineStr"><is><t>Inline</t></is></c><c r="B1"><v>42</v></c>`,
    });
    expect(await extractTextFromXlsx(buffer)).toBe("Sheet 1\n1,Inline,42");
  });

  test("concatenates rich-text runs within one shared string", async () => {
    const zip = new JSZip();
    zip.file(
      "xl/sharedStrings.xml",
      `<?xml version="1.0"?><sst xmlns="${SHEET_NS}"><si><r><t>Hello </t></r><r><t>World</t></r></si></sst>`,
    );
    zip.file(
      "xl/worksheets/sheet1.xml",
      `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
    );
    const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
    expect(await extractTextFromXlsx(buffer)).toBe("Sheet 1\n1,Hello World");
  });

  test("returns cell text verbatim, without leaking or mangling markup", async () => {
    // A cell whose content looks like an HTML tag is stored entity-encoded in the
    // XML; a real parser returns it as literal text. (The old regex tag-stripping
    // was flagged by CodeQL as incomplete sanitization.)
    const buffer = await buildXlsx({
      sharedStrings: ["<script>alert(1)</script>"],
      cells: `<c r="A1" t="s"><v>0</v></c>`,
    });
    expect(await extractTextFromXlsx(buffer)).toBe(
      "Sheet 1\n1,<script>alert(1)</script>",
    );
  });

  test("separates sheets into titled blocks with a blank line", async () => {
    const zip = new JSZip();
    const sheet = (cells: string) =>
      `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData><row r="1">${cells}</row></sheetData></worksheet>`;
    zip.file(
      "xl/worksheets/sheet1.xml",
      sheet(`<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c>`),
    );
    zip.file("xl/worksheets/sheet2.xml", sheet(`<c r="A1"><v>3</v></c>`));
    const buffer = Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));

    expect(await extractTextFromXlsx(buffer)).toBe(
      "Sheet 1\n1,1,2\n\nSheet 2\n1,3",
    );
  });

  test("titles each sheet with its index and tab name, in workbook order", async () => {
    const buffer = await buildNamedXlsx([
      { name: "Revenue", cells: ["100", "200"] },
      { name: "Costs", cells: ["50"] },
    ]);
    expect(await extractTextFromXlsx(buffer)).toBe(
      "Sheet 1: Revenue\n1,100,200\n\nSheet 2: Costs\n1,50",
    );
  });

  test("reads sheets in workbook (tab) order, not worksheet-file order", async () => {
    // Tab order is Beta then Alpha, but Beta's part is sheet2.xml and Alpha's is
    // sheet1.xml — a file-name sort would flip them.
    const buffer = await buildNamedXlsx([
      { name: "Beta", cells: ["b"], file: "sheet2.xml", rid: "rId2" },
      { name: "Alpha", cells: ["a"], file: "sheet1.xml", rid: "rId1" },
    ]);
    expect(await extractTextFromXlsx(buffer)).toBe(
      "Sheet 1: Beta\n1,b\n\nSheet 2: Alpha\n1,a",
    );
  });

  test("returns an empty string for a non-ZIP buffer", async () => {
    expect(await extractTextFromXlsx(Buffer.from("not a zip"))).toBe("");
  });
});
