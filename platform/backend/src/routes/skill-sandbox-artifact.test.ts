import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import config from "@/config";
import { FileModel, SkillSandboxModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { fileStore } from "@/skills-sandbox/file-store";
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

function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? "file";
}

async function seedArtifact(params: {
  sandboxId?: string;
  userId: string;
  organizationId: string;
  mimeType: string;
  data: Buffer;
  path?: string;
  projectId?: string | null;
}) {
  const path = params.path ?? "/sandbox/skills/example/out.png";
  return await fileStore.put({
    organizationId: params.organizationId,
    userId: params.userId,
    projectId: params.projectId ?? null,
    conversationId: null,
    sandboxId: params.sandboxId ?? null,
    filename: basename(path),
    mimeType: params.mimeType,
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

  test("serves an untracked (obj_) artifact whose ref exceeds Fastify's default path-length limit", async () => {
    // obj_ refs encode base64url(JSON{scope,key}), which runs well past Fastify's
    // default maxParamLength of 100; without raising it the route never matches
    // and the request 403s (unmatched route → auth-hook "deny by default").
    const savedProvider = config.fileStorage.provider;
    const savedRoot = config.fileStorage.filesystemRoot;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "artifact-objref-"));
    config.fileStorage.provider = "filesystem";
    config.fileStorage.filesystemRoot = root;
    try {
      const dir = path.join(root, user.email);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "untracked-note.md"), "# hi");

      const [item] = await fileStore.search({
        organizationId,
        userId: user.id,
        scope: { kind: "personal" },
      });
      expect(item.downloadRef.startsWith("obj_")).toBe(true);
      expect(item.downloadRef.length).toBeGreaterThan(100);

      const response = await app.inject({
        method: "GET",
        url: `/api/skill-sandbox/artifacts/${item.downloadRef}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.rawPayload.toString()).toBe("# hi");
    } finally {
      config.fileStorage.provider = savedProvider;
      config.fileStorage.filesystemRoot = savedRoot;
      await fs.rm(root, { recursive: true, force: true });
    }
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
    expect(response.headers["cache-control"]).toBe("private, no-cache");
    expect(response.headers.etag).toBeTruthy();
    expect(response.rawPayload).toEqual(PNG_FAKE);
  });

  test("revalidates with a content ETag so an edited file never previews stale", async () => {
    // The preview panel and the download button hit this same URL; with a
    // time-based cache an in-place edit (same row id) made the preview serve
    // pre-edit bytes while the download showed the new ones. A content ETag +
    // no-cache keeps them in lockstep.
    const sandbox = await seedSandbox({ organizationId, userId: user.id });
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("one joke"),
      path: "/sandbox/skills/example/jokes.txt",
    });

    const first = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, no-cache");
    const etag = first.headers.etag as string;
    expect(etag).toBeTruthy();

    // unchanged file → conditional GET revalidates to 304 (no stale body, no
    // needless re-transfer).
    const revalidated = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
      headers: { "if-none-match": etag },
    });
    expect(revalidated.statusCode).toBe(304);

    // edit the bytes in place (edit_file): same id, same URL, new content.
    await fileStore.update({
      file: artifact,
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength("two jokes!!"),
      data: Buffer.from("two jokes!!"),
    });

    // the browser's conditional GET with the OLD etag now misses → fresh bytes,
    // matching what a download would return.
    const afterEdit = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
      headers: { "if-none-match": etag },
    });
    expect(afterEdit.statusCode).toBe(200);
    expect(afterEdit.body).toBe("two jokes!!");
    expect(afterEdit.headers.etag).not.toBe(etag);
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
});

describe("My Files list routes", () => {
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
      files: Array<{
        filename: string;
        downloadable: boolean;
        id: string | null;
        projectId: string | null;
        projectName: string | null;
      }>;
    }>();
    expect(body.files).toHaveLength(1);
    expect(body.files[0]).toMatchObject({
      filename: "out.txt",
      downloadable: true,
      projectId: null,
      projectName: null,
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

describe("project file cross-user access", () => {
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

  async function seedProjectFile(params: {
    ownerId: string;
    authorId: string;
    name: string;
    content: string;
    filename: string;
  }) {
    const { projectService } = await import("@/services/project");
    const project = await projectService.create({
      organizationId,
      userId: params.ownerId,
      name: params.name,
      description: null,
    });
    const sandbox = await SkillSandboxModel.create({
      organizationId,
      userId: params.authorId,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    const file = await seedArtifact({
      sandboxId: sandbox.id,
      userId: params.authorId,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from(params.content),
      path: `/sandbox/${params.filename}`,
      projectId: project.id,
    });
    return { project, file };
  }

  test("project members see and download files produced by others", async ({
    makeUser,
  }) => {
    // `user` owns the project; `member` produced a file into it.
    const member = await makeUser({ email: "cross-member@test.com" });
    const { project, file } = await seedProjectFile({
      ownerId: user.id,
      authorId: member.id,
      name: "crossuser",
      content: "member",
      filename: "member-output.txt",
    });

    // listing: the owner's My Files include the project's file
    const files = await app.inject({
      method: "GET",
      url: "/api/skill-sandbox/files",
    });
    const body = files.json<{
      files: Array<{
        id: string | null;
        filename: string;
        projectId: string | null;
        projectName: string | null;
      }>;
    }>();
    expect(body.files).toEqual([
      expect.objectContaining({
        id: file.id,
        filename: "member-output.txt",
        projectId: project.id,
        projectName: "crossuser",
      }),
    ]);

    // bytes: downloadable by any project member (here, the owner)
    const bytes = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${file.id}`,
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe("member");
  });

  test("a non-member gets 404 for a project's files", async ({ makeUser }) => {
    const owner = await makeUser({ email: "cross-owner@test.com" });
    const { file } = await seedProjectFile({
      ownerId: owner.id,
      authorId: owner.id,
      name: "notmine",
      content: "secret",
      filename: "secret.txt",
    });

    // `user` (the request principal) has no access to the project
    const denied = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${file.id}`,
    });
    expect(denied.statusCode).toBe(404);
    const files = await app.inject({
      method: "GET",
      url: "/api/skill-sandbox/files",
    });
    expect(files.json<{ files: unknown[] }>().files).toEqual([]);
  });

  test("a shared project grants members full rights — list, read, AND delete", async ({
    makeUser,
    makeMember,
  }) => {
    const { ProjectShareModel } = await import("@/models");
    await makeMember(user.id, organizationId, {});
    const owner = await makeUser({ email: "share-owner@test.com" });
    const { project, file } = await seedProjectFile({
      ownerId: owner.id,
      authorId: owner.id,
      name: "teamshared",
      content: "shared",
      filename: "shared.txt",
    });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });

    // the member's My Files include the shared project's files
    const files = await app.inject({
      method: "GET",
      url: "/api/skill-sandbox/files",
    });
    const body = files.json<{
      files: Array<{
        id: string | null;
        filename: string;
        projectName: string | null;
      }>;
    }>();
    expect(body.files).toEqual([
      expect.objectContaining({
        id: file.id,
        filename: "shared.txt",
        projectName: "teamshared",
      }),
    ]);

    // bytes are readable through the share...
    const bytes = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${file.id}`,
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe("shared");

    // ...and project access is full rights — deletion is allowed too.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/skill-sandbox/artifacts/${file.id}`,
    });
    expect(del.statusCode).toBe(200);
    const after = await app.inject({
      method: "GET",
      url: "/api/skill-sandbox/files",
    });
    expect(after.json<{ files: unknown[] }>().files).toEqual([]);
  });

  test("unsharing a project revokes access to its files", async ({
    makeUser,
    makeMember,
  }) => {
    const { ProjectShareModel } = await import("@/models");
    await makeMember(user.id, organizationId, {});
    const owner = await makeUser({ email: "unshare-owner@test.com" });
    const { project, file } = await seedProjectFile({
      ownerId: owner.id,
      authorId: owner.id,
      name: "unshared",
      content: "bytes",
      filename: "doc.txt",
    });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    // shared: reachable
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/skill-sandbox/artifacts/${file.id}`,
        })
      ).statusCode,
    ).toBe(200);

    await ProjectShareModel.remove(project.id);

    // revoked: both the bytes and the listing
    const denied = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${file.id}`,
    });
    expect(denied.statusCode).toBe(404);
    const after = await app.inject({
      method: "GET",
      url: "/api/skill-sandbox/files",
    });
    expect(after.json<{ files: unknown[] }>().files).toEqual([]);
  });
});

describe("DELETE /api/skill-sandbox/artifacts/:artifactId", () => {
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

  test("the producer can delete their artifact; it leaves the listing", async () => {
    const sandbox = await seedSandbox({ organizationId, userId: user.id });
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("bye"),
      path: "/sandbox/bye.txt",
    });

    const del = await app.inject({
      method: "DELETE",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });
    expect(del.statusCode).toBe(200);

    expect(await FileModel.findById(artifact.id)).toBeNull();
    const bytes = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${artifact.id}`,
    });
    expect(bytes.statusCode).toBe(404);
  });

  test("a project member can delete a member-produced file; non-members cannot", async ({
    makeUser,
  }) => {
    const { projectService } = await import("@/services/project");
    const project = await projectService.create({
      organizationId,
      userId: user.id,
      name: "deletable",
      description: null,
    });
    const member = await makeUser({ email: "delete-member@test.com" });
    const memberSandbox = await SkillSandboxModel.create({
      organizationId,
      userId: member.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    const produced = await seedArtifact({
      sandboxId: memberSandbox.id,
      userId: member.id, // author
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("x"),
      path: "/sandbox/member.txt",
      projectId: project.id,
    });

    // a non-member of the project cannot delete (checked via the store)
    const { fileStore } = await import("@/skills-sandbox/file-store");
    const stranger = await makeUser({ email: "delete-stranger@test.com" });
    expect(
      await fileStore.delete({
        ref: produced.id,
        organizationId,
        userId: stranger.id,
      }),
    ).toBe(false);

    // the project owner (a member) deletes via the route
    const del = await app.inject({
      method: "DELETE",
      url: `/api/skill-sandbox/artifacts/${produced.id}`,
    });
    expect(del.statusCode).toBe(200);
    expect(await FileModel.findById(produced.id)).toBeNull();
  });
});

describe("projects feature gating", () => {
  let user: User;
  let organizationId: string;
  const original = config.projects.enabled;

  // The plugin reads the flag at registration time, so each test builds its own
  // app after setting the flag to the value it needs.
  async function buildApp() {
    const app = createFastifyInstance();
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
    return app;
  }

  beforeEach(async ({ makeOrganization, makeUser }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;
  });

  afterEach(() => {
    (config.projects as { enabled: boolean }).enabled = original;
  });

  test("My Files list 404s when off, but the byte route still streams", async () => {
    const sandbox = await seedSandbox({ organizationId, userId: user.id });
    const artifact = await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "image/png",
      data: PNG_FAKE,
    });

    (config.projects as { enabled: boolean }).enabled = false;
    const app = await buildApp();
    try {
      const files = await app.inject({
        method: "GET",
        url: "/api/skill-sandbox/files",
      });
      expect(files.statusCode).toBe(404);

      // the byte endpoint is always registered regardless of the flag
      const bytes = await app.inject({
        method: "GET",
        url: `/api/skill-sandbox/artifacts/${artifact.id}`,
      });
      expect(bytes.statusCode).toBe(200);
      expect(bytes.rawPayload).toEqual(PNG_FAKE);
    } finally {
      await app.close();
    }
  });

  test("My Files list 200s when on", async () => {
    const sandbox = await seedSandbox({ organizationId, userId: user.id });
    await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("hi"),
      path: "/sandbox/skills/example/out.txt",
    });

    (config.projects as { enabled: boolean }).enabled = true;
    const app = await buildApp();
    try {
      const files = await app.inject({
        method: "GET",
        url: "/api/skill-sandbox/files",
      });
      expect(files.statusCode).toBe(200);
      const body = files.json<{ files: Array<{ filename: string }> }>();
      expect(body.files.map((f) => f.filename)).toEqual(["out.txt"]);
    } finally {
      await app.close();
    }
  });
});
