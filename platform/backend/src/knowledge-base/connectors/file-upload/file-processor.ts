import JSZip from "jszip";
import logger from "@/logging";
import { extractTextFromDocx } from "../docx-text-extractor";

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const MAX_ZIP_TOTAL_BYTES = 50 * 1024 * 1024;

type FileKind = "text" | "pdf" | "docx" | "doc" | "zip" | "unsupported";

const EXTENSION_TO_KIND: Record<string, FileKind> = {
  txt: "text",
  md: "text",
  markdown: "text",
  csv: "text",
  json: "text",
  xml: "text",
  html: "text",
  htm: "text",
  pdf: "pdf",
  docx: "docx",
  doc: "doc",
  zip: "zip",
};

interface ExtractedFile {
  filename: string;
  text: string;
  rawBytes: Buffer;
  mimeType: string;
}

interface SkippedFile {
  filename: string;
  reason: "unsupported" | "too_large" | "extraction_failed";
}

interface ExtractionResult {
  extracted: ExtractedFile[];
  skipped: SkippedFile[];
}

export function isSupportedMimeType(
  filename: string,
  mimeType: string,
): boolean {
  return getFileKind(filename, mimeType) !== "unsupported";
}

export async function extractTextFiles(
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<ExtractionResult> {
  const kind = getFileKind(filename, mimeType);

  switch (kind) {
    case "zip":
      return extractFromZip(buffer);
    case "pdf":
      return toResult(await extractFromPdf(buffer, filename));
    case "docx":
      return toResult(await extractFromDocx(buffer, filename));
    case "doc":
      return extractFromDoc(buffer, filename);
    case "text":
      return toResult([
        {
          filename,
          text: buffer.toString("utf-8"),
          rawBytes: buffer,
          mimeType,
        },
      ]);
    default:
      return { extracted: [], skipped: [] };
  }
}

// =============================================================================
// Internal Helpers
// =============================================================================

function getFileKind(filename: string, mimeType: string): FileKind {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const normalized = mimeType.split(";")[0].trim().toLowerCase();

  if (
    ext === "zip" ||
    normalized === "application/zip" ||
    normalized === "application/x-zip-compressed"
  ) {
    return "zip";
  }
  if (ext === "pdf" || normalized === "application/pdf") {
    return "pdf";
  }
  if (
    ext === "docx" ||
    normalized ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "docx";
  }
  if (ext === "doc" || normalized === "application/msword") {
    return "doc";
  }

  return EXTENSION_TO_KIND[ext] ?? "unsupported";
}

function toResult(extracted: ExtractedFile[]): ExtractionResult {
  return { extracted, skipped: [] };
}

async function extractFromPdf(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedFile[]> {
  const { createRequire } = await import("node:module");
  const requireCjs = createRequire(import.meta.url);
  const pdfParse = requireCjs(
    "pdf-parse/lib/pdf-parse.js",
  ) as typeof import("pdf-parse");
  const data = await pdfParse(buffer);
  return [
    {
      filename,
      text: data.text,
      rawBytes: buffer,
      mimeType: "application/pdf",
    },
  ];
}

async function extractFromDocx(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedFile[]> {
  const text = await extractTextFromDocx(buffer);
  return [
    {
      filename,
      text,
      rawBytes: buffer,
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ];
}

async function extractFromDoc(
  buffer: Buffer,
  filename: string,
): Promise<ExtractionResult> {
  try {
    const text = await extractTextFromDocx(buffer);
    return toResult([
      {
        filename,
        text,
        rawBytes: buffer,
        mimeType: "application/msword",
      },
    ]);
  } catch (error) {
    logger.warn(
      { err: error, filename },
      "Failed to extract text from .doc file, skipping",
    );
    return {
      extracted: [],
      skipped: [{ filename, reason: "extraction_failed" }],
    };
  }
}

async function extractFromZip(buffer: Buffer): Promise<ExtractionResult> {
  const zip = await JSZip.loadAsync(buffer);
  const extracted: ExtractedFile[] = [];
  const skipped: SkippedFile[] = [];
  let totalBytes = 0;

  for (const [relativePath, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    const basename = relativePath.split("/").pop() ?? relativePath;

    // Skip hidden files (.DS_Store, .gitignore, __MACOSX, etc.)
    if (basename.startsWith(".")) continue;
    if (relativePath.startsWith("__MACOSX/")) continue;
    const filename = relativePath;

    const kind = getFileKind(basename, "");
    if (kind === "unsupported" || kind === "zip") {
      skipped.push({ filename, reason: "unsupported" });
      continue;
    }

    const rawBytes = await file.async("nodebuffer");

    if (rawBytes.byteLength > MAX_FILE_SIZE_BYTES) {
      skipped.push({ filename, reason: "too_large" });
      continue;
    }

    totalBytes += rawBytes.byteLength;
    if (totalBytes > MAX_ZIP_TOTAL_BYTES) {
      skipped.push({ filename, reason: "too_large" });
      break;
    }

    try {
      const result = await extractTextFiles(rawBytes, "", filename);
      extracted.push(...result.extracted);
      skipped.push(...result.skipped);
    } catch (error) {
      logger.warn(
        { err: error, filename },
        "Failed to extract file from ZIP entry, skipping",
      );
      skipped.push({ filename, reason: "extraction_failed" });
    }
  }

  return { extracted, skipped };
}
