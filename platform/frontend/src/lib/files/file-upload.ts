/**
 * Why this file rejects a dropped file before it is sent. The size cap mirrors
 * the server's {@link MAX_PROJECT_UPLOAD_BYTES} so the user gets instant feedback
 * instead of a round-trip 413, and a zero-byte file is almost always a mistake
 * (and the server rejects it too).
 */
export type UploadValidation =
  | { ok: true }
  | { ok: false; reason: "too_large" | "empty" };

export function validateUploadFile(
  file: Pick<File, "size">,
  maxBytes: number,
): UploadValidation {
  if (file.size === 0) {
    return { ok: false, reason: "empty" };
  }
  if (file.size > maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true };
}

/**
 * Read a file into raw base64 (no `data:` prefix) for the JSON upload body. Uses
 * FileReader's data-URL output and strips the prefix — a real browser boundary,
 * so the size/empty gate (not this) is what the unit tests cover.
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Unexpected file read result"));
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("File read failed"));
    reader.readAsDataURL(file);
  });
}

/** Per-file outcome of a multi-file upload (one request per file). */
export type UploadOutcome = {
  name: string;
  ok: boolean;
  reason?: "too_large" | "empty" | "server";
};

export type UploadToast = { type: "success" | "error"; message: string };

/**
 * Turn per-file upload outcomes into the toasts to show. Client-side rejections
 * (too large / empty) get their own actionable toast; on top of that exactly one
 * outcome toast summarizes the batch. Critically, an all-failed batch still
 * surfaces server failures even when some files were rejected client-side first.
 */
export function summarizeUploadResults(
  results: UploadOutcome[],
  maxMb: number,
): UploadToast[] {
  if (results.length === 0) return [];
  const toasts: UploadToast[] = [];
  for (const result of results) {
    if (result.reason === "too_large") {
      toasts.push({
        type: "error",
        message: `${result.name} is too large (max ${maxMb} MB)`,
      });
    } else if (result.reason === "empty") {
      toasts.push({ type: "error", message: `${result.name} is empty` });
    }
  }
  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;
  if (failed === 0) {
    toasts.push({
      type: "success",
      message:
        results.length === 1 ? "File uploaded" : `Uploaded ${succeeded} files`,
    });
  } else if (succeeded > 0) {
    toasts.push({
      type: "error",
      message: `Uploaded ${succeeded} of ${results.length}; ${failed} failed`,
    });
  } else if (results.some((r) => r.reason === "server")) {
    // Everything failed and at least one was a server error with no specific
    // toast above — surface it rather than failing silently.
    toasts.push({ type: "error", message: "Upload failed" });
  }
  return toasts;
}
