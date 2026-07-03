import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ADMIN_ROLE_NAME,
  EDITABLE_TEXT_FILE_MAX_BYTES,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "@archestra/shared";
import config from "@/config";
import { FileModel, SkillSandboxModel } from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
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
  conversationId?: string | null;
}) {
  const path = params.path ?? "/sandbox/skills/example/out.png";
  return await fileStore.put({
    organizationId: params.organizationId,
    userId: params.userId,
    projectId: params.projectId ?? null,
    conversationId: params.conversationId ?? null,
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
      const { ProjectModel } = await import("@/models");
      const project = await ProjectModel.create({
        organizationId,
        userId: user.id,
        name: "Obj Ref Proj",
        description: null,
      });
      const dir = path.join(root, project.slug);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "untracked-note.md"), "# hi");

      const [item] = await fileStore.search({
        organizationId,
        userId: user.id,
        scope: {
          kind: "project",
          projectId: project.id,
          projectName: project.name,
        },
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

describe("GET /api/skill-sandbox/conversations/:conversationId/artifacts", () => {
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

  test("lists only this conversation's artifacts, authored by the caller", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent({ organizationId });
    const conv = await makeConversation(agent.id, {
      userId: user.id,
      organizationId,
    });
    const other = await makeConversation(agent.id, {
      userId: user.id,
      organizationId,
    });
    await seedArtifact({
      userId: user.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("here"),
      path: "/sandbox/here.txt",
      conversationId: conv.id,
    });
    await seedArtifact({
      userId: user.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("there"),
      path: "/sandbox/there.txt",
      conversationId: other.id,
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/conversations/${conv.id}/artifacts`,
    });
    expect(response.statusCode).toBe(200);
    expect(
      response.json<Array<{ filename: string }>>().map((f) => f.filename),
    ).toEqual(["here.txt"]);
  });

  test("returns [] for a conversation with no sandbox files", async ({
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

  test("project members can download files produced by others", async ({
    makeUser,
  }) => {
    // `user` owns the project; `member` produced a file into it.
    const member = await makeUser({ email: "cross-member@test.com" });
    const { file } = await seedProjectFile({
      ownerId: user.id,
      authorId: member.id,
      name: "crossuser",
      content: "member",
      filename: "member-output.txt",
    });

    // bytes: downloadable by any project member (here, the owner)
    const bytes = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${file.id}`,
    });
    expect(bytes.statusCode).toBe(200);
    expect(bytes.body).toBe("member");
  });

  test("a non-member gets 404 downloading a project's file", async ({
    makeUser,
  }) => {
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
  });

  test("a shared project grants members read AND delete on its files", async ({
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
    expect(await FileModel.findById(file.id)).toBeNull();
  });

  test("unsharing a project revokes download access to its files", async ({
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

    // revoked: the bytes are no longer reachable
    const denied = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${file.id}`,
    });
    expect(denied.statusCode).toBe(404);
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

  test("the project instructions file cannot be deleted via the route (409)", async () => {
    const { projectService } = await import("@/services/project");
    const project = await projectService.create({
      organizationId,
      userId: user.id,
      name: "instr-undeletable",
      description: null,
    });
    await fileStore.writeProjectInstructions({
      organizationId,
      userId: user.id,
      projectId: project.id,
      content: "do not delete me",
    });
    const row = await FileModel.findByProjectAndName({
      organizationId,
      projectId: project.id,
      filename: PROJECT_INSTRUCTIONS_FILENAME,
    });
    expect(row).not.toBeNull();

    const del = await app.inject({
      method: "DELETE",
      url: `/api/skill-sandbox/artifacts/${row?.id}`,
    });
    expect(del.statusCode).toBe(409);
    // still there
    expect(await FileModel.findById(row?.id ?? "")).not.toBeNull();
  });
});

describe("conversation-artifacts route", () => {
  let user: User;
  let organizationId: string;

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

  test("lists the artifacts produced in a conversation's sandbox", async ({
    makeAgent,
    makeConversation,
  }) => {
    const agent = await makeAgent({ organizationId });
    const conv = await makeConversation(agent.id, {
      userId: user.id,
      organizationId,
    });
    await seedArtifact({
      userId: user.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("hi"),
      path: "/sandbox/skills/example/out.txt",
      conversationId: conv.id,
    });

    const app = await buildApp();
    try {
      const list = await app.inject({
        method: "GET",
        url: `/api/skill-sandbox/conversations/${conv.id}/artifacts`,
      });
      expect(list.statusCode).toBe(200);
      const body = list.json<Array<{ filename: string }>>();
      expect(body.map((f) => f.filename)).toEqual(["out.txt"]);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/skill-sandbox/artifacts/:artifactId — project admin oversight", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser();
    await makeMember(owner.id, organizationId, {});
    actingUser = owner;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = actingUser;
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

  test("a project admin can download AND delete a foreign project's file, but never a personal one", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "oversight-files",
      description: null,
    });
    const sandbox = await seedSandbox({ organizationId, userId: owner.id });
    const projectFile = await seedArtifact({
      sandboxId: sandbox.id,
      userId: owner.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("project bytes"),
      path: "/sandbox/in-project.txt",
      projectId: project.id,
    });
    const personalFile = await seedArtifact({
      sandboxId: sandbox.id,
      userId: owner.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("personal bytes"),
      path: "/sandbox/personal.txt",
      projectId: null,
    });

    const admin = await makeUser({ email: "artifact-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    actingUser = admin;

    // Reads the project file (oversight) ...
    const projectRead = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${projectFile.id}`,
    });
    expect(projectRead.statusCode).toBe(200);
    expect(projectRead.rawPayload.toString()).toBe("project bytes");

    // ... but a personal (non-project) file is never exposed ...
    const personalRead = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${personalFile.id}`,
    });
    expect(personalRead.statusCode).toBe(404);

    // ... project-file deletion IS a granted oversight capability ...
    const del = await app.inject({
      method: "DELETE",
      url: `/api/skill-sandbox/artifacts/${projectFile.id}`,
    });
    expect(del.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/skill-sandbox/artifacts/${projectFile.id}`,
        })
      ).statusCode,
    ).toBe(404);

    // ... but a personal (non-project) file can be neither read nor deleted.
    const personalDel = await app.inject({
      method: "DELETE",
      url: `/api/skill-sandbox/artifacts/${personalFile.id}`,
    });
    expect(personalDel.statusCode).toBe(404);
  });
});

describe("PUT /api/skill-sandbox/artifacts/:artifactId/content", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser();
    await makeMember(owner.id, organizationId, {});
    actingUser = owner;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: unknown }).user = actingUser;
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

  async function bytesOf(ref: string): Promise<string> {
    const res = await app.inject({
      method: "GET",
      url: `/api/skill-sandbox/artifacts/${ref}`,
    });
    return res.rawPayload.toString();
  }

  test("the author overwrites their own .txt; bytes and size update", async () => {
    const sandbox = await seedSandbox({ organizationId, userId: owner.id });
    const file = await seedArtifact({
      sandboxId: sandbox.id,
      userId: owner.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("old"),
      path: "/sandbox/note.txt",
      projectId: null,
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/skill-sandbox/artifacts/${file.id}/content`,
      payload: { content: "new content" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      fileId: file.id,
      filename: "note.txt",
      mimeType: "text/plain",
      sizeBytes: Buffer.byteLength("new content"),
    });
    expect(await bytesOf(file.id)).toBe("new content");
  });

  test("empty content is a valid save", async () => {
    const sandbox = await seedSandbox({ organizationId, userId: owner.id });
    const file = await seedArtifact({
      sandboxId: sandbox.id,
      userId: owner.id,
      organizationId,
      mimeType: "text/markdown",
      data: Buffer.from("# heading"),
      path: "/sandbox/doc.md",
      projectId: null,
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/skill-sandbox/artifacts/${file.id}/content`,
      payload: { content: "" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sizeBytes).toBe(0);
    expect(await bytesOf(file.id)).toBe("");
  });

  test("a shared-project member (not the author) can edit a project .md", async ({
    makeUser,
    makeMember,
  }) => {
    const { ProjectShareModel } = await import("@/models");
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "shared-edit",
      description: null,
    });
    const sandbox = await seedSandbox({ organizationId, userId: owner.id });
    const file = await seedArtifact({
      sandboxId: sandbox.id,
      userId: owner.id,
      organizationId,
      mimeType: "text/markdown",
      data: Buffer.from("owner draft"),
      path: "/sandbox/shared.md",
      projectId: project.id,
    });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });

    const member = await makeUser({ email: "edit-member@test.com" });
    await makeMember(member.id, organizationId, {});
    actingUser = member;
    const res = await app.inject({
      method: "PUT",
      url: `/api/skill-sandbox/artifacts/${file.id}/content`,
      payload: { content: "member edit" },
    });
    expect(res.statusCode).toBe(200);
    expect(await bytesOf(file.id)).toBe("member edit");
  });

  test("a non-member cannot edit a project's file (404, bytes unchanged)", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "private-edit",
      description: null,
    });
    const sandbox = await seedSandbox({ organizationId, userId: owner.id });
    const file = await seedArtifact({
      sandboxId: sandbox.id,
      userId: owner.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("secret"),
      path: "/sandbox/secret.txt",
      projectId: project.id,
    });

    const outsider = await makeUser({ email: "outsider@test.com" });
    await makeMember(outsider.id, organizationId, {});
    actingUser = outsider;
    const res = await app.inject({
      method: "PUT",
      url: `/api/skill-sandbox/artifacts/${file.id}/content`,
      payload: { content: "tampered" },
    });
    expect(res.statusCode).toBe(404);
    actingUser = owner;
    expect(await bytesOf(file.id)).toBe("secret");
  });

  test("oversight project:admin can READ a foreign project file but PUT is 404 (read-only)", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "oversight-edit",
      description: null,
    });
    const sandbox = await seedSandbox({ organizationId, userId: owner.id });
    const file = await seedArtifact({
      sandboxId: sandbox.id,
      userId: owner.id,
      organizationId,
      mimeType: "text/markdown",
      data: Buffer.from("owner only"),
      path: "/sandbox/oversee.md",
      projectId: project.id,
    });

    const admin = await makeUser({ email: "edit-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    actingUser = admin;
    // Oversight read works (parity with the GET route's admin fallback) ...
    expect(await bytesOf(file.id)).toBe("owner only");
    // ... but editing is never an oversight capability.
    const res = await app.inject({
      method: "PUT",
      url: `/api/skill-sandbox/artifacts/${file.id}/content`,
      payload: { content: "admin tampered" },
    });
    expect(res.statusCode).toBe(404);
    actingUser = owner;
    expect(await bytesOf(file.id)).toBe("owner only");
  });

  test("a binary (non-text) file is rejected with 415", async () => {
    const sandbox = await seedSandbox({ organizationId, userId: owner.id });
    const file = await seedArtifact({
      sandboxId: sandbox.id,
      userId: owner.id,
      organizationId,
      mimeType: "image/png",
      data: PNG_FAKE,
      path: "/sandbox/chart.png",
      projectId: null,
    });

    const res = await app.inject({
      method: "PUT",
      url: `/api/skill-sandbox/artifacts/${file.id}/content`,
      payload: { content: "not a png" },
    });
    expect(res.statusCode).toBe(415);
  });

  test("content whose byte length exceeds the cap is 413, even when char length fits", async () => {
    const sandbox = await seedSandbox({ organizationId, userId: owner.id });
    const file = await seedArtifact({
      sandboxId: sandbox.id,
      userId: owner.id,
      organizationId,
      mimeType: "text/plain",
      data: Buffer.from("small"),
      path: "/sandbox/big.txt",
      projectId: null,
    });

    // 600k × "é": 600k UTF-16 code units (passes the route's coarse `.max`), but
    // 1.2M UTF-8 bytes — over the cap, caught by the store's byte check.
    const content = "é".repeat(600_000);
    expect(content.length).toBeLessThanOrEqual(EDITABLE_TEXT_FILE_MAX_BYTES);
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(
      EDITABLE_TEXT_FILE_MAX_BYTES,
    );
    const res = await app.inject({
      method: "PUT",
      url: `/api/skill-sandbox/artifacts/${file.id}/content`,
      payload: { content },
    });
    expect(res.statusCode).toBe(413);
    expect(await bytesOf(file.id)).toBe("small");
  });

  test("the project instructions file is never editable here (409) for owner, member, and admin", async ({
    makeUser,
    makeMember,
  }) => {
    const { ProjectShareModel } = await import("@/models");
    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "instructions-guard",
      description: null,
    });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    await fileStore.writeProjectInstructions({
      organizationId,
      userId: owner.id,
      projectId: project.id,
      content: "system guidance",
    });
    const row = await FileModel.findByProjectAndName({
      organizationId,
      projectId: project.id,
      filename: PROJECT_INSTRUCTIONS_FILENAME,
    });
    if (!row) throw new Error("instructions row was not created");

    const member = await makeUser({ email: "instr-member@test.com" });
    await makeMember(member.id, organizationId, {});
    const admin = await makeUser({ email: "instr-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    for (const principal of [owner, member, admin]) {
      actingUser = principal;
      const res = await app.inject({
        method: "PUT",
        url: `/api/skill-sandbox/artifacts/${row.id}/content`,
        payload: { content: "rewritten guidance" },
      });
      expect(res.statusCode).toBe(409);
    }
    expect(
      await fileStore.readProjectInstructions({
        organizationId,
        projectId: project.id,
      }),
    ).toBe("system guidance");
  });

  test("a non-UUID ref is rejected (400) and an unknown UUID is 404", async () => {
    const bad = await app.inject({
      method: "PUT",
      url: "/api/skill-sandbox/artifacts/not-a-uuid/content",
      payload: { content: "x" },
    });
    expect(bad.statusCode).toBe(400);

    const missing = await app.inject({
      method: "PUT",
      url: "/api/skill-sandbox/artifacts/11111111-1111-4111-8111-111111111111/content",
      payload: { content: "x" },
    });
    expect(missing.statusCode).toBe(404);
  });
});
