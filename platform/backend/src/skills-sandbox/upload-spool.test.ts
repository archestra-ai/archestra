import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import config from "@/config";
import SkillSandboxModel from "@/models/skill-sandbox";
import SkillSandboxFileModel from "@/models/skill-sandbox-file";
import SkillSandboxReplayEventModel from "@/models/skill-sandbox-replay-event";
import { expect, test } from "@/test";
import { SPOOL_MIN_BYTES, uploadReplayEntry } from "./upload-spool";

async function makeUpload(params: {
  makeOrganization: () => Promise<{ id: string }>;
  makeUser: () => Promise<{ id: string }>;
  data: Buffer;
}) {
  const org = await params.makeOrganization();
  const user = await params.makeUser();
  const sandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: user.id,
    conversationId: null,
    defaultCwd: "/home/sandbox",
  });
  const row = await SkillSandboxReplayEventModel.appendUpload({
    sandboxId: sandbox.id,
    userId: user.id,
    path: "/home/sandbox/attachments/input.bin",
    mimeType: "application/octet-stream",
    originalName: "input.bin",
    sizeBytes: params.data.byteLength,
    data: params.data,
  });
  if (!row) throw new Error("appendUpload returned null");
  const { data: _data, ...metadata } = row;
  return metadata;
}

/** point the spool at a fresh per-test dir; restore + clean up after `fn`. */
async function withSpoolDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(tmpdir(), "spool-test-"));
  const original = config.skillsSandbox.spoolDir;
  (config.skillsSandbox as { spoolDir: string }).spoolDir = dir;
  try {
    await fn(dir);
  } finally {
    (config.skillsSandbox as { spoolDir: string }).spoolDir = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("a small upload inlines its bytes as base64", async ({
  makeOrganization,
  makeUser,
}) => {
  await withSpoolDir(async (dir) => {
    const data = Buffer.from("tiny payload");
    const upload = await makeUpload({ makeOrganization, makeUser, data });

    const entry = await uploadReplayEntry(upload);

    expect(entry.kind).toBe("file");
    expect(entry.file?.encoding).toBe("base64");
    expect(entry.file?.content).toBe(data.toString("base64"));
    expect(entry.file?.hostPath).toBeUndefined();
    // nothing spooled for inline transport
    await expect(fs.readdir(dir)).resolves.toEqual([]);
  });
});

test("a large upload spools its bytes and references them by host path", async ({
  makeOrganization,
  makeUser,
}) => {
  await withSpoolDir(async (dir) => {
    const data = Buffer.alloc(SPOOL_MIN_BYTES, 0x61);
    const upload = await makeUpload({ makeOrganization, makeUser, data });

    const entry = await uploadReplayEntry(upload);

    expect(entry.file?.encoding).toBe("binary");
    expect(entry.file?.content).toBe("");
    expect(entry.file?.hostPath).toBe(path.join(dir, upload.id));
    const spooled = await fs.readFile(path.join(dir, upload.id));
    expect(spooled.equals(data)).toBe(true);
  });
});

test("a spool hit skips the database payload read", async ({
  makeOrganization,
  makeUser,
}) => {
  await withSpoolDir(async () => {
    const data = Buffer.alloc(SPOOL_MIN_BYTES + 1, 0x62);
    const upload = await makeUpload({ makeOrganization, makeUser, data });
    await uploadReplayEntry(upload);

    const readSpy = vi.spyOn(SkillSandboxFileModel, "findUploadDataById");
    try {
      const entry = await uploadReplayEntry(upload);
      expect(entry.file?.hostPath).toBeDefined();
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  });
});

test("a spool file with the wrong size is rewritten from the database", async ({
  makeOrganization,
  makeUser,
}) => {
  await withSpoolDir(async (dir) => {
    const data = Buffer.alloc(SPOOL_MIN_BYTES, 0x63);
    const upload = await makeUpload({ makeOrganization, makeUser, data });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, upload.id), "truncated");

    const entry = await uploadReplayEntry(upload);

    expect(entry.file?.hostPath).toBe(path.join(dir, upload.id));
    const spooled = await fs.readFile(path.join(dir, upload.id));
    expect(spooled.equals(data)).toBe(true);
  });
});
