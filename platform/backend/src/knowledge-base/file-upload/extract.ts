import {
  extractTextFromDocx,
  isCorruptOfficeFileError,
} from "@/knowledge-base/connectors/docx-text-extractor";
import {
  describePdfEmptyText,
  describePdfExtractionWarning,
} from "@/knowledge-base/connectors/pdf-utils";
import { extractPdfText, type OcrRunContext } from "@/knowledge-base/pdf-ocr";
import { ApiError } from "@/types";

/**
 * Text pulled out of an uploaded file, ready to be indexed.
 *
 * `warning` carries a partial-extraction note — a PDF where some pages parsed
 * and others did not. The file is still indexed; the caller surfaces the note
 * so a half-read document is never silently presented as complete.
 */
interface ExtractedFile {
  text: string;
  warning?: string;
}

/** Extensions accepted on upload, and what each is parsed as. */
const EXTENSION_KINDS = {
  pdf: "pdf",
  docx: "docx",
  txt: "text",
  md: "text",
  markdown: "text",
  csv: "text",
  json: "text",
  html: "text",
  htm: "text",
} as const;

type FileKind = (typeof EXTENSION_KINDS)[keyof typeof EXTENSION_KINDS];

const SUPPORTED_UPLOAD_EXTENSIONS = Object.keys(EXTENSION_KINDS);

/**
 * Extract indexable text from an uploaded file.
 *
 * Extraction is decided by extension, not by the browser-supplied MIME type:
 * clients send `application/octet-stream` for anything they don't recognise,
 * and a wrong MIME type would silently route a readable file to the reject
 * path.
 *
 * A file we cannot read is an error rather than an empty document. An empty
 * document embeds to nothing, retrieves nothing, and looks to the user exactly
 * like a successful upload — so the failure has to be visible at upload time.
 */
export async function extractText(params: {
  buffer: Buffer;
  filename: string;
  /**
   * Transcribe textless PDF pages with the organization's OCR model. Passed
   * at indexing time — where the transcription is what gets indexed — and
   * deliberately absent at upload validation, which must not spend model
   * budget on a file that is merely being stored.
   */
  ocr?: OcrRunContext;
  /**
   * Accept a scanned PDF (textless pages, no extractable text) instead of
   * rejecting it, returning empty text. Upload validation passes true when
   * the organization has OCR configured: the file is storable because
   * indexing will transcribe it.
   */
  acceptTextlessPdf?: boolean;
}): Promise<ExtractedFile> {
  const kind = fileKind(params.filename);
  if (!kind) {
    throw new ApiError(
      400,
      `Cannot read "${params.filename}". Supported types: ${SUPPORTED_UPLOAD_EXTENSIONS.join(", ")}.`,
    );
  }

  switch (kind) {
    case "pdf":
      return extractPdf(params);
    case "docx":
      return extractDocx(params.buffer, params.filename);
    case "text":
      return { text: params.buffer.toString("utf-8") };
  }
}

// ===== Internal =====

function fileKind(filename: string): FileKind | null {
  const extension = filename.split(".").pop()?.toLowerCase();
  if (!extension) return null;
  return EXTENSION_KINDS[extension as keyof typeof EXTENSION_KINDS] ?? null;
}

async function extractPdf(params: {
  buffer: Buffer;
  filename: string;
  ocr?: OcrRunContext;
  acceptTextlessPdf?: boolean;
}): Promise<ExtractedFile> {
  const { buffer, filename, ocr, acceptTextlessPdf } = params;
  const result = await extractPdfText({ buffer, filename, ocr });

  // `describePdfEmptyText` returns a reason only for the statuses that yield no
  // usable text — a scanned page image with no text layer being the common one.
  // When OCR ran, the reason also names what the transcription pass could not do.
  const emptyReason = describePdfEmptyText(result);
  if (emptyReason) {
    const hasTextlessPages = (result.pages ?? []).some(
      (page) => page.status === "textless",
    );
    if (acceptTextlessPdf && hasTextlessPages) {
      return {
        text: "",
        warning:
          "Scanned document — its pages will be transcribed when the file is indexed into a knowledge base.",
      };
    }
    throw new ApiError(400, `Cannot read "${filename}": ${emptyReason}.`);
  }

  return {
    text: result.text,
    warning: describePdfExtractionWarning(result),
  };
}

async function extractDocx(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedFile> {
  let text: string;
  try {
    text = await extractTextFromDocx(buffer);
  } catch (error) {
    if (isCorruptOfficeFileError(error)) {
      throw new ApiError(
        400,
        `Cannot read "${filename}": the file is not a valid .docx.`,
      );
    }
    throw error;
  }

  // extractTextFromDocx maps a mislabeled/corrupt OOXML file to "" rather than
  // throwing. For a connector sync that means "skip the item"; for a file a
  // user just chose by hand it means the upload did nothing, so it is an error
  // here.
  if (!text.trim()) {
    throw new ApiError(400, `Cannot read "${filename}": no extractable text.`);
  }

  return { text };
}
