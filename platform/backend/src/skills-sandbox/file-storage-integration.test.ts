import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "@/config";
import {
  SkillSandboxFileModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
} from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { getSandboxFileStorage } from "./file-storage";

describe("sandbox file storage: filesystem mode end-to-end (models + PGlite)", () => {
  let root: string;
  const original = { ...config.skillsSandbox.fileStorage };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "sandbox-int-"));
    config.skillsSandbox.fileStorage.provider = "filesystem";
    config.skillsSandbox.fileStorage.path = root;
  });

  afterEach(async () => {
    config.skillsSandbox.fileStorage.provider = original.provider;
    config.skillsSandbox.fileStorage.path = original.path;
    await rm(root, { recursive: true, force: true });
  });

  async function makeSandbox(fixtures: {
    makeUser: (overrides?: object) => Promise<{ id: string }>;
    makeOrganization: () => Promise<{ id: string }>;
  }) {
    const user = await fixtures.makeUser();
    const org = await fixtures.makeOrganization();
    // verified signature: SkillSandboxModel.create takes InsertSkillSandbox —
    // organizationId, userId, conversationId (nullable), defaultCwd
    // (see models/skill-sandbox.ts:29 and its use in
    // skill-sandbox-runtime-service.test.ts and skill-sandbox-artifact.test.ts)
    return await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
  }

  test("appendUpload stores bytes on disk and a pointer row; replay reads them back", async ({
    makeUser,
    makeOrganization,
  }) => {
    const sandbox = await makeSandbox({ makeUser, makeOrganization });
    const row = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      path: "/home/sandbox/input.txt",
      mimeType: "text/plain",
      originalName: "input.txt",
      sizeBytes: 9,
      data: Buffer.from("phase2 in"),
    });
    expect(row).not.toBeNull();
    expect(row?.storageProvider).toBe("filesystem");
    expect(row?.data).toBeNull();
    expect(row?.objectKey).toBe(`${sandbox.id}/uploads/input.txt`);
    // bytes are on disk
    const onDisk = await readFile(join(root, row?.objectKey ?? ""));
    expect(onDisk.toString()).toBe("phase2 in");
    // replay assembly reads them back through the router
    const entries = await SkillSandboxReplayEventModel.listBySandbox(
      sandbox.id,
    );
    const upload = entries.find((e) => e.kind === "upload");
    expect(upload).toBeDefined();
    if (upload?.kind === "upload") {
      const bytes = await getSandboxFileStorage().get(upload.upload);
      expect(bytes.toString()).toBe("phase2 in");
    }
  });

  test("createArtifact stores bytes on disk; artifact read round-trips", async ({
    makeUser,
    makeOrganization,
  }) => {
    const sandbox = await makeSandbox({ makeUser, makeOrganization });
    const artifact = await SkillSandboxFileModel.createArtifact({
      sandboxId: sandbox.id,
      path: "/home/sandbox/out.txt",
      mimeType: "text/plain",
      originalName: null,
      sizeBytes: 9,
      data: Buffer.from("phase2 ok"),
    });
    expect(artifact.storageProvider).toBe("filesystem");
    expect(artifact.objectKey).toBe(`${sandbox.id}/artifacts/out.txt`);
    expect(artifact.data).toBeNull();
    const fetched = await SkillSandboxFileModel.findArtifactById(artifact.id);
    expect(fetched).not.toBeNull();
    const bytes = await getSandboxFileStorage().get(fetched ?? artifact);
    expect(bytes.toString()).toBe("phase2 ok");
  });

  test("mixed mode: db rows written before the switch still read correctly", async ({
    makeUser,
    makeOrganization,
  }) => {
    const sandbox = await makeSandbox({ makeUser, makeOrganization });
    // simulate a pre-switch row: write under db config
    config.skillsSandbox.fileStorage.provider = "db";
    config.skillsSandbox.fileStorage.path = undefined;
    const oldRow = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      path: "/home/sandbox/old.txt",
      mimeType: "text/plain",
      originalName: "old.txt",
      sizeBytes: 3,
      data: Buffer.from("old"),
    });
    // switch to filesystem and write a new row
    config.skillsSandbox.fileStorage.provider = "filesystem";
    config.skillsSandbox.fileStorage.path = root;
    const newRow = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      path: "/home/sandbox/new.txt",
      mimeType: "text/plain",
      originalName: "new.txt",
      sizeBytes: 3,
      data: Buffer.from("new"),
    });
    if (!oldRow || !newRow)
      throw new Error("appendUpload returned null unexpectedly");
    expect(oldRow.storageProvider).toBe("db");
    expect(newRow.storageProvider).toBe("filesystem");
    // both read back through the same router, each from its own home
    const storage = getSandboxFileStorage();
    expect((await storage.get(oldRow)).toString()).toBe("old");
    expect((await storage.get(newRow)).toString()).toBe("new");
  });

  test("attachment-staging conflict cleans up the orphaned disk file", async ({
    makeUser,
    makeOrganization,
  }) => {
    const sandbox = await makeSandbox({ makeUser, makeOrganization });
    const attachmentId = "99999999-8888-7777-6666-555555555555";
    const params = {
      sandboxId: sandbox.id,
      path: "/home/sandbox/attachments/dup.txt",
      mimeType: "text/plain",
      originalName: "dup.txt",
      sizeBytes: 3,
      data: Buffer.from("dup"),
      sourceAttachmentId: attachmentId,
    };
    const first = await SkillSandboxReplayEventModel.appendUpload(params);
    expect(first).not.toBeNull();
    const second = await SkillSandboxReplayEventModel.appendUpload(params);
    expect(second).toBeNull();
    // exactly one file on disk: the conflict no-op removed its orphan
    const files = await readdir(join(root, sandbox.id, "uploads"));
    expect(files).toEqual(["dup.txt"]);
  });
});
