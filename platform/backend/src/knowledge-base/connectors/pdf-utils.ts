import pdfJs from "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js";

/**
 * Outcome of PDF text extraction. `partial` means usable text was recovered,
 * but at least one page failed extraction or was image-only, so callers must
 * warn that the indexed representation is incomplete.
 */
type PdfExtractionStatus =
  | "ok"
  | "partial"
  | "no_text_layer"
  | "empty"
  | "parse_failed";

interface PdfExtractionResult {
  text: string;
  status: PdfExtractionStatus;
  pageCount?: number;
  failedPageCount?: number;
  imageOnlyPageCount?: number;
  graphicsOnlyPageCount?: number;
  blankPageCount?: number;
  error?: string;
}

/**
 * Human-readable explanation of why a PDF yielded no text, for skip
 * reporting on the connector run. Returns undefined when any text was
 * extracted; partial extraction has a separate warning description.
 */
export function describePdfEmptyText(
  result: PdfExtractionResult,
): string | undefined {
  switch (result.status) {
    case "ok":
    case "partial":
      return undefined;
    case "no_text_layer": {
      const details = describeEmptyPages(result);
      return `PDF has ${result.pageCount} page(s) but no extractable text layer${details ? ` (${details})` : ""}`;
    }
    case "empty":
      return "PDF contains no pages";
    case "parse_failed":
      return `PDF could not be parsed or its pages could not be extracted${result.error ? `: ${result.error}` : ""}`;
  }
}

/**
 * Warning for a PDF that produced some searchable text but not a complete
 * representation of every page.
 */
export function describePdfExtractionWarning(
  result: PdfExtractionResult,
): string | undefined {
  if (result.status !== "partial") return undefined;

  const causes: string[] = [];
  if (result.failedPageCount) {
    causes.push(
      `${result.failedPageCount} page${result.failedPageCount === 1 ? "" : "s"} failed extraction`,
    );
  }
  if (result.imageOnlyPageCount) {
    causes.push(
      `${result.imageOnlyPageCount} image-only page${result.imageOnlyPageCount === 1 ? "" : "s"} had no text layer`,
    );
  }
  if (result.graphicsOnlyPageCount) {
    causes.push(
      `${result.graphicsOnlyPageCount} graphics-only page${result.graphicsOnlyPageCount === 1 ? "" : "s"} had no text layer`,
    );
  }
  return `PDF text extraction was incomplete: ${causes.join("; ")}. Text from the remaining pages was indexed.`;
}

/**
 * Extract text from a PDF while preserving page-level outcomes.
 *
 * pdf-parse's wrapper catches each `getPage`/page-render rejection and replaces
 * it with an empty string, making a failed page indistinguishable from a scan.
 * Work directly with its pinned pdf.js build instead so page errors, image-only
 * pages, and genuinely blank pages remain distinct.
 *
 * Never throws: document-level and page-level failures are returned as status
 * metadata so connector runs can skip or warn with an actionable reason.
 */
export async function parsePdfBuffer(
  buffer: Buffer,
): Promise<PdfExtractionResult> {
  let loadingTask: ReturnType<typeof pdfJs.getDocument> | undefined;
  let document:
    | Awaited<ReturnType<typeof pdfJs.getDocument>["promise"]>
    | undefined;

  try {
    pdfJs.disableWorker = true;
    // pdf.js defaults to recovery mode and can silently resolve partial page
    // output after font/XObject/content-stream errors. Strict mode makes those
    // failures observable so incomplete content is never reported as `ok`.
    loadingTask = pdfJs.getDocument({ data: buffer, stopAtErrors: true });
    document = await loadingTask.promise;
    const pageCount = document.numPages;
    if (pageCount === 0) {
      return { text: "", status: "empty", pageCount: 0 };
    }

    const pageTexts: string[] = [];
    const pageErrors: string[] = [];
    let failedPageCount = 0;
    let imageOnlyPageCount = 0;
    let graphicsOnlyPageCount = 0;
    let blankPageCount = 0;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      try {
        const page = await document.getPage(pageNumber);
        try {
          const textContent = await page.getTextContent({
            normalizeWhitespace: false,
            disableCombineTextItems: false,
          });
          const pageText = renderPageText(textContent.items);

          if (pageText.trim()) {
            pageTexts.push(pageText);
            continue;
          }

          const operatorList = await page.getOperatorList();
          if (
            operatorList.fnArray.some((operation) =>
              IMAGE_OPERATIONS.has(operation),
            )
          ) {
            imageOnlyPageCount++;
          } else if (
            operatorList.fnArray.some((operation) =>
              VISIBLE_MARKING_OPERATIONS.has(operation),
            )
          ) {
            graphicsOnlyPageCount++;
          } else {
            blankPageCount++;
          }
        } finally {
          // Operator lists can retain decoded full-page images. Release each
          // page before moving on so large scanned PDFs do not accumulate all
          // page resources until document destruction.
          try {
            page.cleanup();
          } catch {
            // Cleanup cannot change the extraction outcome.
          }
        }
      } catch (error) {
        failedPageCount++;
        pageErrors.push(
          `page ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const text = pageTexts.join("\n\n").trim();
    const counts = {
      ...(failedPageCount > 0 ? { failedPageCount } : {}),
      ...(imageOnlyPageCount > 0 ? { imageOnlyPageCount } : {}),
      ...(graphicsOnlyPageCount > 0 ? { graphicsOnlyPageCount } : {}),
      ...(blankPageCount > 0 ? { blankPageCount } : {}),
    };

    if (failedPageCount > 0 && !text) {
      return {
        text: "",
        status: "parse_failed",
        pageCount,
        ...counts,
        error: summarizePageErrors(pageErrors),
      };
    }
    if (!text) {
      return {
        text: "",
        status: "no_text_layer",
        pageCount,
        ...counts,
      };
    }
    if (
      failedPageCount > 0 ||
      imageOnlyPageCount > 0 ||
      graphicsOnlyPageCount > 0
    ) {
      return {
        text,
        status: "partial",
        pageCount,
        ...counts,
        ...(pageErrors.length > 0
          ? { error: summarizePageErrors(pageErrors) }
          : {}),
      };
    }
    return { text, status: "ok", pageCount, ...counts };
  } catch (error) {
    return {
      text: "",
      status: "parse_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      if (document) {
        await document.destroy();
      } else {
        await loadingTask?.destroy();
      }
    } catch {
      // Extraction outcome is already known; cleanup failure must not replace
      // it with a thrown connector error.
    }
  }
}

const IMAGE_OPERATIONS = new Set(
  [
    pdfJs.OPS.paintJpegXObject,
    pdfJs.OPS.paintImageMaskXObject,
    pdfJs.OPS.paintImageMaskXObjectGroup,
    pdfJs.OPS.paintImageXObject,
    pdfJs.OPS.paintInlineImageXObject,
    pdfJs.OPS.paintInlineImageXObjectGroup,
    pdfJs.OPS.paintImageXObjectRepeat,
    pdfJs.OPS.paintImageMaskXObjectRepeat,
    pdfJs.OPS.paintSolidColorImageMask,
  ].filter((operation): operation is number => typeof operation === "number"),
);

// A textless page is only genuinely blank when it contains no visible paint
// operation. Vector paths become visible at stroke/fill, annotations carry
// their own nested paint operations, and text-showing operations can remain
// visible even when extraction yields no text items (for example broken font
// mappings).
const VISIBLE_MARKING_OPERATIONS = new Set(
  [
    pdfJs.OPS.stroke,
    pdfJs.OPS.closeStroke,
    pdfJs.OPS.fill,
    pdfJs.OPS.eoFill,
    pdfJs.OPS.fillStroke,
    pdfJs.OPS.eoFillStroke,
    pdfJs.OPS.closeFillStroke,
    pdfJs.OPS.closeEOFillStroke,
    pdfJs.OPS.showText,
    pdfJs.OPS.showSpacedText,
    pdfJs.OPS.nextLineShowText,
    pdfJs.OPS.nextLineSetSpacingShowText,
    pdfJs.OPS.shadingFill,
    pdfJs.OPS.paintXObject,
    pdfJs.OPS.paintFormXObjectBegin,
  ].filter((operation): operation is number => typeof operation === "number"),
);

function renderPageText(
  items: Array<{ str?: string; transform?: number[] }>,
): string {
  let lastY: number | undefined;
  let text = "";

  for (const item of items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform?.[5];
    if (text && lastY !== undefined && y !== undefined && y !== lastY) {
      text += "\n";
    }
    text += item.str;
    lastY = y;
  }

  return text;
}

function summarizePageErrors(errors: string[]): string {
  const shown = errors.slice(0, 3);
  const remainder = errors.length - shown.length;
  return `${shown.join("; ")}${remainder > 0 ? `; and ${remainder} more` : ""}`;
}

function describeEmptyPages(result: PdfExtractionResult): string {
  const details: string[] = [];
  if (result.imageOnlyPageCount) {
    details.push(`${result.imageOnlyPageCount} image-only`);
  }
  if (result.graphicsOnlyPageCount) {
    details.push(`${result.graphicsOnlyPageCount} graphics-only`);
  }
  if (result.blankPageCount) {
    details.push(`${result.blankPageCount} blank`);
  }
  return details.join(", ");
}
