import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import config from "@/config";
import { SkillSandboxFileModel, SkillSandboxModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_FAKE = Buffer.concat([PNG_HEADER, Buffer.alloc(64, 0xab)]);

async function seedSandbox(params: { organizationId: string; userId: string }) {
  return await SkillSandboxModel.create({
    organizationId: params.organizationId,
    userId: params.userId,
    conversationId: null,
    defaultCwd: "/sandbox/skills/example",
  });
}

async function seedArtifact(params: {
  sandboxId: string;
  userId: string;
  organizationId: string;
  mimeType: string;
  data: Buffer;
  path?: string;
}) {
  return await SkillSandboxFileModel.createArtifact({
    sandboxId: params.sandboxId,
    userId: params.userId,
    path: params.path ?? "/sandbox/skills/example/out.png",
    mimeType: params.mimeType,
    originalName: null,
    sizeBytes: params.data.byteLength,
    data: params.data,
  });
}

describe("GET /api/skill-sandbox/artifacts/:artifactId", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: skillSandboxArtifactRoutes } = await import(
      "./skill-sandbox-artifact"
    );
    await app.register(skillSandboxArtifactRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  test("serves inline-safe images with inline disposition and security headers", async () => {
    const sandbox = await seedSandbox({
      organizationId,
      userId: user.id,
    });
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "image/png",
      data: PNG_FAKE,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/png");
    expect(response.headers["content-disposition"]).toContain("inline");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["content-security-policy"]).toBe(
      "default-src 'none'; sandbox",
    );
    expect(response.headers["cache-control"]).toBe("private, max-age=300");
    expect(response.rawPayload).toEqual(PNG_FAKE);
  });

  test("serves SVG as attachment + octet-stream (never inline as HTML)", async () => {
    const sandbox = await seedSandbox({
      organizationId,
      userId: user.id,
    });
    const svgPayload = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "image/svg+xml",
      data: svgPayload,
      path: "/sandbox/skills/example/icon.svg",
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.headers["content-disposition"]).toContain("attachment");
    expect(response.headers["content-disposition"]).toContain("icon.svg");
  });

  test("returns 404 when the artifact's sandbox belongs to another user", async ({
    makeUser,
    makeOrganization,
  }) => {
    const otherUser = await makeUser({ email: "other@test.com" });
    const otherOrg = await makeOrganization();
    const otherSandbox = await seedSandbox({
      organizationId: otherOrg.id,
      userId: otherUser.id,
    });
    const artifact = await seedArtifact({
      sandboxId: otherSandbox.id,
      userId: otherUser.id,
      organizationId: otherOrg.id,
      mimeType: "image/png",
      data: PNG_FAKE,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 404 for unknown artifact id (avoids existence-disclosure)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/skill-sandbox/artifacts/00000000-0000-0000-0000-000000000000",
    });

    expect(response.statusCode).toBe(404);
  });

  test("sanitizes filename in Content-Disposition", async () => {
    const sandbox = await seedSandbox({
      organizationId,
      userId: user.id,
    });
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "application/pdf",
      data: Buffer.from("%PDF-1.4 ..."),
      path: '/sandbox/skills/example/weird"name\\with-quote.pdf',
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });

    expect(response.statusCode).toBe(200);
    const cd = response.headers["content-disposition"] as string;
    // user-supplied quote and backslash inside the filename are stripped so
    // the header stays parseable. wrapping quotes around filename are fine.
    expect(cd).toMatch(/^attachment; filename="[^"\\]*"$/);
    expect(cd).toContain(".pdf");
  });

  describe("SandboxFileMissingError → 404", () => {
    let fsRoot: string;
    const original = { ...config.skillsSandbox.fileStorage };

    beforeEach(async () => {
      fsRoot = await mkdtemp(join(tmpdir(), "sandbox-art-404-"));
      config.skillsSandbox.fileStorage.provider = "filesystem";
      config.skillsSandbox.fileStorage.path = fsRoot;
    });

    afterEach(async () => {
      config.skillsSandbox.fileStorage.provider = original.provider;
      config.skillsSandbox.fileStorage.path = original.path;
      await rm(fsRoot, { recursive: true, force: true });
    });

    test("returns 404 with 'Artifact data is no longer available' when the backing file is deleted", async () => {
      const sandbox = await seedSandbox({
        organizationId,
        userId: user.id,
      });
      const artifact = await seedArtifact({
        sandboxId: sandbox.id,
        userId: user.id,
        organizationId,
        mimeType: "text/plain",
        data: Buffer.from("soon deleted"),
        path: "/sandbox/skills/example/ephemeral.txt",
      });
      // confirm the artifact was written as filesystem-mode
      expect(artifact.storageProvider).toBe("filesystem");
      if (!artifact.objectKey) throw new Error("expected filesystem objectKey");

      // remove the backing file from disk to simulate operator deletion
      await unlink(join(fsRoot, artifact.objectKey));

      const response = await app.inject({
        method: "GET",
        url: `/api/skill-sandbox/artifacts/${artifact.id}`,
      });

      expect(response.statusCode).toBe(404);
      expect(
        response.json<{ error: { message: string } }>().error.message,
      ).toBe("Artifact data is no longer available");
    });
  });
});

describe("X-Files list routes", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    const { default: skillSandboxArtifactRoutes } = await import(
      "./skill-sandbox-artifact"
    );
    await app.register(skillSandboxArtifactRoutes);
  });
  afterEach(async () => {
    await app.close();
  });

  test("GET /api/skill-sandbox/files lists the user's artifacts (db mode, downloadable)", async () => {
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("hi"),
      path: "/sandbox/skills/example/out.txt",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/skill-sandbox/files",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{
      folders: Array<{ id: string | null; name: string }>;
      files: Array<{
        filename: string;
        downloadable: boolean;
        id: string | null;
      }>;
    }>();
    expect(body.folders).toEqual([]);
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      filename: "out.txt",
      downloadable: true,
      folder: null,
    });
    expect(body.files[0].id).toBeTruthy();
  });

  test("GET conversation artifacts returns [] for a conversation with no sandbox files", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent({ organizationId });
    const conv = await makeConversation(agent.id, {
      userId: user.id,
      organizationId,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/conversations/${conv.id}/artifacts`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
  });

  test("GET /api/skill-sandbox/files never returns another user's files", async ({
    makeUser,
    makeOrganization,
  }) => {
    // the request is authenticated as `user`/`organizationId` (the harness).
    const mineSandbox = await SkillSandboxModel.create({
      organizationId,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    await seedArtifact({
      sandboxId: mineSandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("mine"),
      path: "/sandbox/skills/example/mine.txt",
    });

    const otherUser = await makeUser({ email: "x-files-other@test.com" });
    const otherOrg = await makeOrganization();
    const theirSandbox = await SkillSandboxModel.create({
      organizationId: otherOrg.id,
      userId: otherUser.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    await seedArtifact({
      sandboxId: theirSandbox.id,
      userId: otherUser.id,
      organizationId: otherOrg.id,
      mimeType: "text/plain",
      data: Buffer.from("theirs"),
      path: "/sandbox/skills/example/theirs.txt",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/skill-sandbox/files",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ files: Array<{ filename: string }> }>();
    expect(body.files.map((f) => f.filename)).toEqual(["mine.txt"]);
  });
});

describe("POST /api/skill-sandbox/folders + GET /api/skill-sandbox/uploads/:uploadId", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });

    const { default: skillSandboxArtifactRoutes } = await import(
      "./skill-sandbox-artifact"
    );
    await app.register(skillSandboxArtifactRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test("uploads route serves own bytes, 404s other users' and artifact ids", async ({
    makeUser,
    makeOrganization,
  }) => {
    const sandbox = await seedSandbox({ organizationId, userId: user.id });
    const { SkillSandboxReplayEventModel } = await import("@/models");
    const upload = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: sandbox.id,
      userId: user.id,
      path: "/sandbox/skills/example/in.txt",
      mimeType: "text/plain",
      originalName: "in.txt",
      sizeBytes: 5,
      data: Buffer.from("hello"),
      origin: "x_file",
    });

    const ok = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/uploads/${upload?.id}`,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("hello");
    expect(ok.headers["content-type"]).toBe("application/octet-stream");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect(ok.headers["content-security-policy"]).toContain("sandbox");
    expect(ok.headers["content-disposition"]).toContain("attachment");

    // an artifact id is not reachable through the uploads route
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("artifact"),
      path: "/sandbox/skills/example/a.txt",
    });
    const wrongKind = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/uploads/${artifact.id}`,
    });
    expect(wrongKind.statusCode).toBe(404);

    // another user's upload id 404s identically
    const stranger = await makeUser({ email: "uploads-stranger@test.com" });
    const strangerOrg = await makeOrganization();
    const strangerSandbox = await SkillSandboxModel.create({
      organizationId: strangerOrg.id,
      userId: stranger.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    const strangerUpload = await SkillSandboxReplayEventModel.appendUpload({
      sandboxId: strangerSandbox.id,
      userId: stranger.id,
      path: "/sandbox/secret.txt",
      mimeType: "text/plain",
      originalName: null,
      sizeBytes: 6,
      data: Buffer.from("secret"),
    });
    const denied = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/uploads/${strangerUpload?.id}`,
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).not.toContain("secret");
  });
});
