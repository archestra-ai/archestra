import * as cheerio from "cheerio";
import JSZip from "jszip";
import { isCorruptOfficeFileError } from "./docx-text-extractor";

/**
 * Extract plain text from a .pptx (OOXML presentation) buffer, slide by slide
 * in order.
 *
 * Slide text lives in DrawingML `<a:t>` runs. The XML is parsed with a real
 * parser and text is read via `.text()`, so markup can never leak into the
 * output (unlike regex tag-stripping, which is both incomplete and fragile).
 * Returns "" for a file whose bytes are not a valid ZIP (mislabeled/corrupt/
 * truncated), so the caller skips it instead of failing.
 */
export async function extractTextFromPptx(buffer: Buffer): Promise<string> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch (err) {
    if (isCorruptOfficeFileError(err)) return "";
    throw err;
  }

  const slidePaths = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));

  const parts: string[] = [];
  for (const slidePath of slidePaths) {
    const $ = cheerio.load(await zip.files[slidePath].async("text"), {
      xml: true,
    });
    // `<a:t>` is namespaced; css-select treats ":" as a pseudo-selector, so
    // match on the tag name directly rather than via a selector.
    const runs: string[] = [];
    $("*").each((_, el) => {
      if ("tagName" in el && el.tagName === "a:t") runs.push($(el).text());
    });
    const slideText = runs.join(" ").trim();
    if (slideText) parts.push(slideText);
  }

  return parts.join("\n\n");
}

/** Numeric slide index from a `ppt/slides/slideN.xml` path (for ordering). */
function slideNumber(name: string): number {
  return Number.parseInt(name.match(/slide(\d+)/)?.[1] ?? "0", 10);
}
