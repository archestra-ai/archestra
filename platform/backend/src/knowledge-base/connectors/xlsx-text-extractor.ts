import * as cheerio from "cheerio";
import JSZip from "jszip";
import { isCorruptOfficeFileError } from "./docx-text-extractor";

/**
 * Extract plain text from an .xlsx (OOXML spreadsheet) buffer.
 *
 * Most cell text lives in a shared-strings table referenced by index from the
 * worksheets; inline strings and raw values live on the cells themselves. The
 * XML is parsed with a real parser and text is read via `.text()`, so markup
 * can never leak into the output (unlike regex tag-stripping, which is both
 * incomplete and fragile). Returns "" for a file whose bytes are not a valid
 * ZIP (mislabeled/corrupt/truncated), so the caller skips it instead of failing.
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

  const parts: string[] = [];
  const sheetPaths = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort();
  for (const sheetPath of sheetPaths) {
    const xml = await zip.files[sheetPath].async("text");
    const $ = cheerio.load(xml, { xml: true });
    $("c").each((_, cell) => {
      const $cell = $(cell);
      // t="s" → <v> holds an index into the shared-strings table.
      if ($cell.attr("t") === "s") {
        const shared =
          sharedStrings[
            Number.parseInt($cell.children("v").first().text(), 10)
          ];
        if (shared) parts.push(shared);
        return;
      }
      // Inline string (t="inlineStr"): text lives in <is><t>.
      const inline = $cell.find("is t").text();
      if (inline) {
        parts.push(inline);
        return;
      }
      // Numbers, booleans, and formula string results (t="str") live in <v>.
      const value = $cell.children("v").first().text();
      if (value) parts.push(value);
    });
  }

  return parts.join(" ");
}

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
