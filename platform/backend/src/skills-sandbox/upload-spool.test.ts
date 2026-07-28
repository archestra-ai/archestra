import { promises as fs } from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import SkillSandboxModel from "@/models/skill-sandbox";
import SkillSandboxFileModel from "@/models/skill-sandbox-file";
import SkillSandboxReplayEventModel from "@/models/skill-sandbox-replay-event";
import { expect, test } from "@/test";
import {
  SANDBOX_UPLOAD_SPOOL_ROOT,
  SPOOL_MIN_BYTES,
  uploadReplayEntry,
  warmUploadSpool,
} from "./upload-spool";

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

// The spool dir is a fixed location (deliberately unconfigurable), so tests
// share it; entries are row-id-named (uuids), so each test only ever touches
// its own file and removes it when done.
const spoolPath = (id: string) => path.join(SANDBOX_UPLOAD_SPOOL_ROOT, id);

test("a small upload inlines its bytes as base64 and never spools", async ({
  makeOrganization,
  makeUser,
}) => {
  const data = Buffer.from("tiny payload");
  const upload = await makeUpload({ makeOrganization, makeUser, data });

  const entry = await uploadReplayEntry(upload);

  expect(entry.kind).toBe("file");
  expect(entry.file?.encoding).toBe("base64");
  expect(entry.file?.content).toBe(data.toString("base64"));
  expect(entry.file?.hostPath).toBeUndefined();
  await expect(fs.stat(spoolPath(upload.id))).rejects.toThrow();
});

test("a large upload spools its bytes and references them by host path", async ({
  makeOrganization,
  makeUser,
}) => {
  const data = Buffer.alloc(SPOOL_MIN_BYTES, 0x61);
  const upload = await makeUpload({ makeOrganization, makeUser, data });
  try {
    const entry = await uploadReplayEntry(upload);

    expect(entry.file?.encoding).toBe("binary");
    expect(entry.file?.content).toBe("");
    expect(entry.file?.hostPath).toBe(spoolPath(upload.id));
    const spooled = await fs.readFile(spoolPath(upload.id));
    expect(spooled.equals(data)).toBe(true);
  } finally {
    await fs.rm(spoolPath(upload.id), { force: true });
  }
});

test("a spool hit skips the database payload read", async ({
  makeOrganization,
  makeUser,
}) => {
  const data = Buffer.alloc(SPOOL_MIN_BYTES + 1, 0x62);
  const upload = await makeUpload({ makeOrganization, makeUser, data });
  try {
    await uploadReplayEntry(upload);

    const readSpy = vi.spyOn(SkillSandboxFileModel, "findUploadDataById");
    try {
      const entry = await uploadReplayEntry(upload);
      expect(entry.file?.hostPath).toBeDefined();
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  } finally {
    await fs.rm(spoolPath(upload.id), { force: true });
  }
});

test("a spool file with the wrong size is rewritten from the database", async ({
  makeOrganization,
  makeUser,
}) => {
  const data = Buffer.alloc(SPOOL_MIN_BYTES, 0x63);
  const upload = await makeUpload({ makeOrganization, makeUser, data });
  try {
    await fs.mkdir(SANDBOX_UPLOAD_SPOOL_ROOT, { recursive: true });
    await fs.writeFile(spoolPath(upload.id), "truncated");

    const entry = await uploadReplayEntry(upload);

    expect(entry.file?.hostPath).toBe(spoolPath(upload.id));
    const spooled = await fs.readFile(spoolPath(upload.id));
    expect(spooled.equals(data)).toBe(true);
  } finally {
    await fs.rm(spoolPath(upload.id), { force: true });
  }
});

test("warmUploadSpool writes from bytes in hand so the first materialize skips the database", async ({
  makeOrganization,
  makeUser,
}) => {
  const data = Buffer.alloc(SPOOL_MIN_BYTES, 0x65);
  const upload = await makeUpload({ makeOrganization, makeUser, data });
  try {
    await warmUploadSpool(upload, data);
    const spooled = await fs.readFile(spoolPath(upload.id));
    expect(spooled.equals(data)).toBe(true);

    const readSpy = vi.spyOn(SkillSandboxFileModel, "findUploadDataById");
    try {
      const entry = await uploadReplayEntry(upload);
      expect(entry.file?.hostPath).toBe(spoolPath(upload.id));
      expect(readSpy).not.toHaveBeenCalled();
    } finally {
      readSpy.mockRestore();
    }
  } finally {
    await fs.rm(spoolPath(upload.id), { force: true });
  }
});

test("warmUploadSpool is a no-op for small uploads", async ({
  makeOrganization,
  makeUser,
}) => {
  const data = Buffer.from("small");
  const upload = await makeUpload({ makeOrganization, makeUser, data });

  await warmUploadSpool(upload, data);

  await expect(fs.stat(spoolPath(upload.id))).rejects.toThrow();
});
