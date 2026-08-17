import pdfJs from "pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js";

/**
 * Outcome of PDF text extraction. `partial` means usable text was recovered,
 * but at least one page failed extraction or yielded no text. A failed page
 * proves the representation is incomplete; a textless page is intentionally
 * ambiguous because it may be blank, image-only, or graphics-only.
 */
type PdfExtractionStatus =
  | "ok"
  | "partial"
  | "no_text_layer"
  | "empty"
  | "parse_failed";

/**
 * Per-page outcome of a successful document parse. `text` holds the page's
 * extracted text; `"textless"` pages parsed cleanly but yielded none (blank,
 * image-only, or graphics-only); `"failed"` pages threw during extraction.
 * Absent entirely when the document itself could not be parsed.
 */
export interface PdfPageOutcome {
  pageNumber: number;
  status: "text" | "textless" | "failed";
  text?: string;
}

/**
 * What the optional OCR pass did to a document's textless pages. Attached to
 * the extraction result by `extractPdfText` (pdf-ocr.ts) so the skip/warning
 * descriptions can tell an admin whether OCR ran, what it recovered, and what
 * stopped it.
 */
export interface OcrOutcome {
  transcribedPageCount: number;
  /** Textless pages OCR attempted but could not transcribe. */
  failedPageCount: number;
  /** Textless pages never attempted because a limit stopped OCR first. */
  skippedPageCount: number;
  /** Which limit stopped scheduling, when skippedPageCount > 0. */
  skippedBy?: "document-page-cap" | "run-page-budget" | "sync-deadline";
  /** Summary of the first failure, for run diagnostics. */
  failureSummary?: string;
}

export interface PdfExtractionResult {
  text: string;
  status: PdfExtractionStatus;
  pageCount?: number;
  failedPageCount?: number;
  textlessPageCount?: number;
  /** Ordered per-page outcomes; only present when the document parsed. */
  pages?: PdfPageOutcome[];
  /** Present when an OCR pass ran over the document's textless pages. */
  ocr?: OcrOutcome;
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
      return `PDF has ${result.pageCount} page(s) but no extractable text layer${details ? ` (${details})` : ""}${describeFailedOcr(result)}`;
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
  const ocrSuffix = describeOcrSummary(result.ocr);

  if (result.failedPageCount) {
    const causes = [
      `${result.failedPageCount} page${result.failedPageCount === 1 ? "" : "s"} failed extraction`,
    ];
    if (result.textlessPageCount) {
      causes.push(describeTextlessPages(result.textlessPageCount));
    }
    return `PDF text extraction was incomplete: ${causes.join("; ")}. Text from the remaining pages was indexed.${ocrSuffix}`;
  }
  if (result.textlessPageCount) {
    return `PDF ${describeTextlessPages(result.textlessPageCount)}. Text from the other pages was indexed.${ocrSuffix}`;
  }
  if (ocrSuffix) {
    // Every originally-textless page was transcribed but some pages had
    // failed extraction, or vice versa — surface the OCR contribution.
    return ocrSuffix.trim();
  }
  return undefined;
}

/**
 * Extract text from a PDF while preserving page-level outcomes.
 *
 * pdf-parse's wrapper catches each `getPage`/page-render rejection and replaces
 * it with an empty string, making a failed page indistinguishable from a scan.
 * Work directly with its pinned pdf.js build instead so page errors and
 * textless pages remain distinct. We intentionally do not request rendering
 * operator lists: that path decodes image XObjects and can make a large scan
 * consume unbounded memory merely to prove that its pages have no text layer.
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
    const pages: PdfPageOutcome[] = [];
    let failedPageCount = 0;
    let textlessPageCount = 0;

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
            pages.push({ pageNumber, status: "text", text: pageText });
            continue;
          }
          // Conservatively record every successfully parsed textless page.
          // Distinguishing a true blank from a scan/vector page requires the
          // render operator list, which decodes image resources and is unsafe
          // for large or adversarial PDFs. The warning keeps that ambiguity.
          textlessPageCount++;
          pages.push({ pageNumber, status: "textless" });
        } finally {
          // Release per-page text/font resources before moving on so large
          // PDFs do not accumulate every page until document destruction.
          try {
            page.cleanup();
          } catch {
            // Cleanup cannot change the extraction outcome.
          }
        }
      } catch (error) {
        failedPageCount++;
        pages.push({ pageNumber, status: "failed" });
        pageErrors.push(
          `page ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const text = pageTexts.join("\n\n").trim();
    const counts = {
      ...(failedPageCount > 0 ? { failedPageCount } : {}),
      ...(textlessPageCount > 0 ? { textlessPageCount } : {}),
    };

    if (failedPageCount > 0 && !text) {
      return {
        text: "",
        status: "parse_failed",
        pageCount,
        ...counts,
        pages,
        error: summarizePageErrors(pageErrors),
      };
    }
    if (!text) {
      return {
        text: "",
        status: "no_text_layer",
        pageCount,
        ...counts,
        pages,
      };
    }
    if (failedPageCount > 0 || textlessPageCount > 0) {
      return {
        text,
        status: "partial",
        pageCount,
        ...counts,
        pages,
        ...(pageErrors.length > 0
          ? { error: summarizePageErrors(pageErrors) }
          : {}),
      };
    }
    return { text, status: "ok", pageCount, ...counts, pages };
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

function describeTextlessPages(count: number): string {
  const pages = `${count} page${count === 1 ? "" : "s"} yielded no text`;
  const subject = count === 1 ? "it may" : "they may";
  return `${pages} (${subject} be blank, image-only, or graphics-only)`;
}

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

/** " ; OCR ..." suffix for a document whose OCR pass recovered nothing. */
function describeFailedOcr(result: PdfExtractionResult): string {
  const ocr = result.ocr;
  if (!ocr || ocr.transcribedPageCount > 0) return "";
  const attempted = ocr.failedPageCount + ocr.skippedPageCount;
  const cause = ocr.failureSummary
    ? `: ${ocr.failureSummary}`
    : ocr.skippedBy
      ? ` (stopped by ${describeOcrLimit(ocr.skippedBy)})`
      : "";
  return `; OCR could not transcribe any of the ${attempted} textless page(s)${cause}`;
}

/** Sentence describing a partially-successful OCR pass, appended to warnings. */
function describeOcrSummary(ocr: OcrOutcome | undefined): string {
  if (!ocr) return "";
  const attempted =
    ocr.transcribedPageCount + ocr.failedPageCount + ocr.skippedPageCount;
  const parts = [
    `OCR transcribed ${ocr.transcribedPageCount} of ${attempted} textless page(s)`,
  ];
  if (ocr.failedPageCount > 0) {
    parts.push(
      `${ocr.failedPageCount} could not be transcribed${ocr.failureSummary ? ` (${ocr.failureSummary})` : ""}`,
    );
  }
  if (ocr.skippedPageCount > 0 && ocr.skippedBy) {
    parts.push(
      `${ocr.skippedPageCount} skipped by the ${describeOcrLimit(ocr.skippedBy)}`,
    );
  }
  return ` ${parts.join("; ")}.`;
}

function describeOcrLimit(limit: NonNullable<OcrOutcome["skippedBy"]>): string {
  switch (limit) {
    case "document-page-cap":
      return "per-document OCR page cap";
    case "run-page-budget":
      return "sync run's OCR page budget";
    case "sync-deadline":
      return "sync run's time budget";
  }
}

function describeEmptyPages(result: PdfExtractionResult): string {
  const details: string[] = [];
  if (result.textlessPageCount) {
    details.push(`${result.textlessPageCount} textless`);
  }
  return details.join(", ");
}
