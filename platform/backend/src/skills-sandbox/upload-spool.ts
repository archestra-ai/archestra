import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReplayEntry } from "@archestra/sandbox-rs";
import logger from "@/logging";
import SkillSandboxFileModel from "@/models/skill-sandbox-file";
import type { SkillSandboxFileMetadata } from "@/types";
import { FileBytesMissingError } from "./object-store";

/**
 * Payload size at which an upload switches from inline `content` (base64 in
 * the recipe, re-shipped to the engine on every materialize) to a host-synced
 * spool file (BuildKit filesync; the recipe carries only a path, and the
 * engine pulls the bytes once per content). Small files stay inline so hook
 * scripts and tiny uploads never touch the spool — and keep their recipes
 * byte-identical to what pre-spool sandboxes recorded, preserving their Dagger
 * layer cache.
 *
 * @public — sizes the fixtures in the transport-choice tests.
 */
export const SPOOL_MIN_BYTES = 256 * 1024;

/**
 * Host-side twin of the in-container attachments dir: the fixed local cache
 * where large upload payloads live for BuildKit filesync. Deliberately not
 * configurable — the location of sandbox file storage never was. Pure cache:
 * recreated from Postgres on demand, safe to clear.
 */
export const SANDBOX_UPLOAD_SPOOL_ROOT = path.join(
  tmpdir(),
  "archestra-sandbox-attachments",
);

/**
 * Write an upload's spool file from bytes already in hand — staging just
 * inserted the row — so the first materialize filesyncs without re-reading
 * the payload from Postgres. Small files never spool. Best-effort: the spool
 * is cache, so a failure only means the first materialize re-reads the row.
 */
export async function warmUploadSpool(
  upload: SkillSandboxFileMetadata,
  data: Buffer,
): Promise<void> {
  if (upload.sizeBytes < SPOOL_MIN_BYTES) return;
  try {
    const dest = path.join(SANDBOX_UPLOAD_SPOOL_ROOT, upload.id);
    const stat = await fs.stat(dest).catch(() => null);
    if (stat?.size === upload.sizeBytes) return;
    await writeSpoolFile(dest, data);
  } catch (error) {
    logger.debug(
      { error, uploadId: upload.id },
      "[UploadSpool] warm-from-bytes failed",
    );
  }
}

/**
 * Build the replay entry for an upload, choosing its byte transport. Large
 * payloads are spooled to {@link SANDBOX_UPLOAD_SPOOL_ROOT} (named by the
 * immutable row id) and referenced via `hostPath`; a spool hit skips the
 * Postgres byte read entirely. Small payloads load lazily and inline as
 * base64, exactly as before.
 */
export async function uploadReplayEntry(
  upload: SkillSandboxFileMetadata,
): Promise<ReplayEntry> {
  if (upload.sizeBytes >= SPOOL_MIN_BYTES) {
    return {
      kind: "file",
      file: {
        path: upload.path,
        encoding: "binary",
        content: "",
        hostPath: await ensureSpooled(upload),
      },
    };
  }
  const data = await loadUploadData(upload.id);
  return {
    kind: "file",
    file: {
      path: upload.path,
      encoding: "base64",
      content: data.toString("base64"),
    },
  };
}

// === internal ===

/**
 * Cap on total spool size; best-effort, enforced after each write by evicting
 * the least-recently-touched entries. Spool files are pure cache — every one
 * is recreated from Postgres on the next demand.
 */
const SPOOL_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** Distinguishes concurrent temp writes of the same spool entry. */
let tempCounter = 0;

/**
 * Ensure the upload's bytes exist as a spool file and return its absolute
 * path. Rows are immutable, so a present file with the expected size is
 * authoritative — its mtime is refreshed so eviction tracks use, not age.
 */
async function ensureSpooled(
  upload: SkillSandboxFileMetadata,
): Promise<string> {
  const dest = path.join(SANDBOX_UPLOAD_SPOOL_ROOT, upload.id);
  try {
    const stat = await fs.stat(dest);
    if (stat.size === upload.sizeBytes) {
      const now = new Date();
      await fs.utimes(dest, now, now).catch(() => {});
      return dest;
    }
    // wrong size can only mean tampering or a torn manual copy — rewrite.
  } catch {
    // missing — write below.
  }

  const data = await loadUploadData(upload.id);
  await writeSpoolFile(dest, data);
  return dest;
}

/** mkdir + atomic tmp/rename publish + best-effort eviction sweep. */
async function writeSpoolFile(dest: string, data: Buffer): Promise<void> {
  const root = path.dirname(dest);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  tempCounter += 1;
  const temp = `${dest}.tmp-${process.pid}-${tempCounter}`;
  await fs.writeFile(temp, data, { mode: 0o600 });
  // atomic publish: concurrent spoolers of the same row race harmlessly —
  // both temps hold identical bytes and the last rename wins.
  await fs.rename(temp, dest);
  void sweepSpool(root, dest).catch((error) => {
    logger.debug({ error, root }, "[UploadSpool] eviction sweep failed");
  });
}

async function loadUploadData(id: string): Promise<Buffer> {
  const data = await SkillSandboxFileModel.findUploadDataById(id);
  if (!data) throw new FileBytesMissingError(id);
  return data;
}

/**
 * Best-effort LRU eviction: when the spool exceeds its cap, remove the
 * least-recently-touched files until under. Never touches `justWritten` or
 * in-flight temp files; failures are logged and ignored (the spool is cache).
 */
async function sweepSpool(root: string, justWritten: string): Promise<void> {
  const names = await fs.readdir(root);
  const entries: { file: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    const file = path.join(root, name);
    if (file === justWritten || name.includes(".tmp-")) continue;
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isFile()) {
      entries.push({ file, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  }
  let total = entries.reduce((sum, e) => sum + e.size, 0);
  if (total <= SPOOL_MAX_BYTES) return;
  entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const entry of entries) {
    if (total <= SPOOL_MAX_BYTES) break;
    await fs.rm(entry.file, { force: true });
    total -= entry.size;
  }
}
