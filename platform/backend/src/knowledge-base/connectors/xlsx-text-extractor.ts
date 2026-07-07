import * as cheerio from "cheerio";
import JSZip from "jszip";
import { isCorruptOfficeFileError } from "./docx-text-extractor";

/**
 * Extract text from an .xlsx (OOXML spreadsheet) buffer, preserving its shape.
 *
 * Each sheet becomes a titled block — `Sheet <n>: <name>` — followed by one line
 * per row in CSV notation: the row number, then the cells comma-separated (fields
 * quoted per RFC 4180 when they contain a comma or quote) so columns stay aligned
 * by their real position (the first row is the header row). Sheets are read in
 * workbook (tab) order and separated by a blank line. Cell text comes from the
 * shared-strings table (referenced by index), inline strings, or raw values; the
 * XML is parsed with a real parser so markup never leaks. Returns "" for bytes
 * that are not a valid ZIP (mislabeled/corrupt/truncated) so the caller skips it.
 */
export async function extractTextFromXlsx(buffer: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    if (isCorruptOfficeFileError(err)) return "";
    throw err;
  }

  const sharedStrings = await readSharedStrings(zip);
  const worksheets = await readWorksheetOrder(zip);

  const blocks: string[] = [];
  for (const [sheetIndex, { name, path }] of worksheets.entries()) {
    const file = zip.file(path);
    if (!file) continue;
    const $ = cheerio.load(await file.async("text"), { xml: true });

    const rows: string[] = [];
    $("sheetData > row").each((_, rowEl) => {
      const $row = $(rowEl);
      const rowNumber = $row.attr("r") ?? String(rows.length + 1);
      const columns: string[] = [];
      $row.children("c").each((_, cellEl) => {
        const $cell = $(cellEl);
        // Resolve the value: shared string (t="s"), inline string, or raw <v>.
        let value: string;
        if ($cell.attr("t") === "s") {
          value =
            sharedStrings[
              Number.parseInt($cell.children("v").first().text(), 10)
            ] ?? "";
        } else {
          value =
            $cell.find("is t").text() || $cell.children("v").first().text();
        }
        // Collapse internal whitespace so a newline inside a cell can't split the
        // row; commas and quotes are handled by CSV-quoting below.
        value = value.replace(/\s+/g, " ").trim();

        // Place the value at its real column (from the "A1"-style ref) so columns
        // line up across rows even when empty cells are omitted from the XML.
        // Refs without column letters fall back to append order.
        const col = columnIndex($cell.attr("r"));
        if (col < 0) {
          if (value) columns.push(value);
          return;
        }
        while (columns.length <= col) columns.push("");
        columns[col] = value;
      });
      if (columns.some((cell) => cell !== "")) {
        rows.push([rowNumber, ...columns].map(toCsvField).join(","));
      }
    });

    const title = name
      ? `Sheet ${sheetIndex + 1}: ${name}`
      : `Sheet ${sheetIndex + 1}`;
    blocks.push(rows.length > 0 ? `${title}\n${rows.join("\n")}` : title);
  }

  // A blank line between titled blocks keeps sheets clearly separated.
  return blocks.join("\n\n");
}

// ===== Internal helpers =====

/** Read the shared-strings table into an index-addressable array of cell text. */
async function readSharedStrings(zip: JSZip): Promise<string[]> {
  const file = zip.file("xl/sharedStrings.xml");
  if (!file) return [];
  const $ = cheerio.load(await file.async("text"), { xml: true });
  // Each <si> may hold several <t> runs (rich text); concatenate their text.
  return $("si")
    .map((_, si) => $(si).find("t").text())
    .get();
}

/**
 * 0-based column index from an "A1"-style cell reference ("B7" → 1, "AA1" → 26).
 * Returns -1 when the reference has no column letters, so the caller appends the
 * value in encounter order instead.
 */
function columnIndex(cellRef: string | undefined): number {
  const letters = cellRef ? /^[A-Za-z]+/.exec(cellRef)?.[0] : undefined;
  if (!letters) return -1;
  let index = 0;
  for (const ch of letters.toUpperCase()) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

/**
 * Encode one field for CSV output (RFC 4180): wrap it in double quotes when it
 * contains a comma, quote, or newline, doubling any embedded quotes.
 */
function toCsvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Resolve worksheets in tab order, paired with their names. Both live in
 * xl/workbook.xml (each <sheet> carries its name and a relationship id); the
 * relationship id maps to the worksheet part path via xl/_rels/workbook.xml.rels.
 * Falls back to enumerating xl/worksheets/sheetN.xml (name-less, numeric order)
 * when that metadata is absent — e.g. a hand-built minimal file.
 */
async function readWorksheetOrder(
  zip: JSZip,
): Promise<Array<{ name: string; path: string }>> {
  const workbook = zip.file("xl/workbook.xml");
  const rels = zip.file("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) return fallbackWorksheetOrder(zip);

  const $rels = cheerio.load(await rels.async("text"), { xml: true });
  const targetById = new Map<string, string>();
  $rels("Relationship").each((_, rel) => {
    const id = $rels(rel).attr("Id");
    const target = $rels(rel).attr("Target");
    if (id && target) targetById.set(id, resolveWorkbookRelPath(target));
  });

  const $wb = cheerio.load(await workbook.async("text"), { xml: true });
  const worksheets: Array<{ name: string; path: string }> = [];
  $wb("sheets > sheet").each((_, sheet) => {
    const relId = $wb(sheet).attr("r:id");
    const path = relId ? targetById.get(relId) : undefined;
    if (path) worksheets.push({ name: $wb(sheet).attr("name") ?? "", path });
  });

  return worksheets.length > 0 ? worksheets : fallbackWorksheetOrder(zip);
}

/** Worksheet parts by naming convention, numerically ordered, without names. */
function fallbackWorksheetOrder(
  zip: JSZip,
): Array<{ name: string; path: string }> {
  return Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => worksheetNumber(a) - worksheetNumber(b))
    .map((path) => ({ name: "", path }));
}

function worksheetNumber(path: string): number {
  const match = path.match(/sheet(\d+)\.xml$/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * A worksheet Target in workbook.xml.rels is relative to xl/ (the workbook's
 * folder); a leading slash makes it an absolute part name within the package.
 */
function resolveWorkbookRelPath(target: string): string {
  return target.startsWith("/") ? target.replace(/^\/+/, "") : `xl/${target}`;
}
