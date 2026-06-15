import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "@/config";
import {
  FileModel,
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

  async function makeOwner(fixtures: {
    makeUser: (overrides?: object) => Promise<{ id: string; email: string }>;
    makeOrganization: () => Promise<{ id: string }>;
  }) {
    const user = await fixtures.makeUser();
    const org = await fixtures.makeOrganization();
    return { user, org };
  }

  async function makeSandboxFor(owner: {
    user: { id: string };
    org: { id: string };
  }) {
    return await SkillSandboxModel.create({
      organizationId: owner.org.id,
      userId: owner.user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
  }

  test("uploads stay in Postgres and never touch the disk; replay reads them back", async ({
    makeUser,
    makeOrganization,
  }) => {
    const owner = await makeOwner({ makeUser, makeOrganization });
    const sandbox = await makeSandboxFor(owner);
    const row = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      userId: owner.user.id,
      path: "/home/sandbox/input.txt",
      mimeType: "text/plain",
      originalName: "input.txt",
      sizeBytes: 9,
      data: Buffer.from("phase3 in"),
    });
    expect(row).not.toBeNull();
    // uploads are Postgres-only: bytes on the row, nothing on disk.
    expect(row?.data?.toString()).toBe("phase3 in");
    // the storage root was never touched
    expect(await readdir(root)).toEqual([]);
    // replay assembly reads the bytes back through the router (per-row dispatch)
    const entries = await SkillSandboxReplayEventModel.listBySandbox(
      sandbox.id,
    );
    const upload = entries.find((e) => e.kind === "upload");
    expect(upload).toBeDefined();
    if (upload?.kind === "upload") {
      const bytes = await getSandboxFileStorage().get(upload.upload);
      expect(bytes.toString()).toBe("phase3 in");
    }
  });

  test("artifacts land flat in the per-user folder", async ({
    makeUser,
    makeOrganization,
  }) => {
    const owner = await makeOwner({ makeUser, makeOrganization });
    const sandbox = await makeSandboxFor(owner);
    const artifact = await FileModel.create({
      organizationId: owner.org.id,
      userId: owner.user.id,
      namespaceUserId: owner.user.id,
      conversationId: null,
      sandboxId: sandbox.id,
      folderId: null,
      folderName: null,
      filename: "out.txt",
      mimeType: "text/plain",
      sizeBytes: 9,
      data: Buffer.from("phase3 ok"),
    });
    expect(artifact.storageProvider).toBe("filesystem");
    expect(artifact.objectKey).toBe(`${owner.user.email}/out.txt`);
    expect(artifact.data).toBeNull();
    const onDisk = await readFile(join(root, owner.user.email, "out.txt"));
    expect(onDisk.toString()).toBe("phase3 ok");
    const fetched = await FileModel.findById(artifact.id);
    expect(fetched).not.toBeNull();
    const bytes = await getSandboxFileStorage().get(fetched ?? artifact);
    expect(bytes.toString()).toBe("phase3 ok");
  });

  test("same-name artifacts from different sandboxes share the folder with counters", async ({
    makeUser,
    makeOrganization,
  }) => {
    const owner = await makeOwner({ makeUser, makeOrganization });
    const sandboxA = await makeSandboxFor(owner);
    const sandboxB = await makeSandboxFor(owner);
    const params = (sandboxId: string, content: string) => ({
      organizationId: owner.org.id,
      userId: owner.user.id,
      namespaceUserId: owner.user.id,
      conversationId: null,
      sandboxId,
      folderId: null,
      folderName: null,
      filename: "report.txt",
      mimeType: "text/plain",
      sizeBytes: content.length,
      data: Buffer.from(content),
    });
    const first = await FileModel.create(params(sandboxA.id, "from A"));
    const second = await FileModel.create(params(sandboxB.id, "from B"));
    const third = await FileModel.create(params(sandboxA.id, "from A again"));
    expect(first.objectKey).toBe(`${owner.user.email}/report.txt`);
    expect(second.objectKey).toBe(`${owner.user.email}/report (1).txt`);
    expect(third.objectKey).toBe(`${owner.user.email}/report (2).txt`);
    // each row reads back its own bytes
    const storage = getSandboxFileStorage();
    expect((await storage.get(first)).toString()).toBe("from A");
    expect((await storage.get(second)).toString()).toBe("from B");
    expect((await storage.get(third)).toString()).toBe("from A again");
  });

  test("attachment-staging conflict leaves no orphan anywhere", async ({
    makeUser,
    makeOrganization,
  }) => {
    const owner = await makeOwner({ makeUser, makeOrganization });
    const sandbox = await makeSandboxFor(owner);
    const params = {
      sandboxId: sandbox.id,
      userId: owner.user.id,
      path: "/home/sandbox/attachments/dup.txt",
      mimeType: "text/plain",
      originalName: "dup.txt",
      sizeBytes: 3,
      data: Buffer.from("dup"),
      sourceAttachmentId: "99999999-8888-7777-6666-555555555555",
    };
    const first = await SkillSandboxReplayEventModel.appendUpload(params);
    expect(first).not.toBeNull();
    const second = await SkillSandboxReplayEventModel.appendUpload(params);
    expect(second).toBeNull();
    // uploads are db-only now: nothing on disk for either call
    expect(await readdir(root)).toEqual([]);
  });
});
