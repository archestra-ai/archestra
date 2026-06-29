import {
  ADMIN_ROLE_NAME,
  MAX_PROJECT_UPLOAD_BYTES,
  PROJECT_INSTRUCTIONS_FILENAME,
} from "@archestra/shared";
import { ProjectShareModel } from "@/models";
import FileModel from "@/models/file";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { projectService } from "@/services/project";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

describe("POST /api/projects/:id/files", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let owner: User;
  let actingUser: User;

  beforeEach(async ({ makeOrganization, makeUser }) => {
    organizationId = (await makeOrganization()).id;
    owner = await makeUser();
    actingUser = owner;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
      (request as typeof request & { user: User }).user = actingUser;
    });
    const { default: projectRoutes } = await import("./project.routes");
    await app.register(projectRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function seedProject(name = "p") {
    return projectService.create({
      organizationId,
      userId: owner.id,
      name,
      description: null,
    });
  }

  const upload = (
    projectId: string,
    body: { name: string; mimeType: string; dataBase64: string },
  ) =>
    app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/files`,
      payload: body,
    });

  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

  test("uploads a file, returns its metadata, and lists it in the project", async () => {
    const project = await seedProject();

    const res = await upload(project.id, {
      name: "notes.txt",
      mimeType: "text/plain",
      dataBase64: b64("hello world"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      filename: "notes.txt",
      mimeType: "text/plain",
    });

    const row = await FileModel.findByProjectAndName({
      organizationId,
      projectId: project.id,
      filename: "notes.txt",
    });
    expect(row).not.toBeNull();
  });

  test("defaults an empty MIME type to application/octet-stream", async () => {
    const project = await seedProject("mime");

    const res = await upload(project.id, {
      name: "blob.bin",
      mimeType: "",
      dataBase64: b64("x"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().mimeType).toBe("application/octet-stream");
  });

  test("auto-renames a colliding filename", async () => {
    const project = await seedProject("dup");

    const first = await upload(project.id, {
      name: "report.pdf",
      mimeType: "application/pdf",
      dataBase64: b64("one"),
    });
    expect(first.json().filename).toBe("report.pdf");

    const second = await upload(project.id, {
      name: "report.pdf",
      mimeType: "application/pdf",
      dataBase64: b64("two"),
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().filename).toBe("report (1).pdf");

    const third = await upload(project.id, {
      name: "report.pdf",
      mimeType: "application/pdf",
      dataBase64: b64("three"),
    });
    expect(third.json().filename).toBe("report (2).pdf");
  });

  test("strips a path component from the uploaded name", async () => {
    const project = await seedProject("path");

    const res = await upload(project.id, {
      name: "../../etc/passwd",
      mimeType: "text/plain",
      dataBase64: b64("data"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().filename).toBe("passwd");
  });

  test("rejects an invalid filename with 400", async () => {
    const project = await seedProject("badname");

    const res = await upload(project.id, {
      name: ".",
      mimeType: "text/plain",
      dataBase64: b64("data"),
    });

    expect(res.statusCode).toBe(400);
  });

  test("rejects uploading the reserved instructions filename", async () => {
    const project = await seedProject("reserved");

    const res = await upload(project.id, {
      name: PROJECT_INSTRUCTIONS_FILENAME,
      mimeType: "text/markdown",
      dataBase64: b64("# sneaky instructions injected into every chat"),
    });

    expect(res.statusCode).toBe(400);
    expect(
      await FileModel.findByProjectAndName({
        organizationId,
        projectId: project.id,
        filename: PROJECT_INSTRUCTIONS_FILENAME,
      }),
    ).toBeNull();
  });

  test("rejects a case variant of the reserved instructions filename", async () => {
    const project = await seedProject("reserved-case");

    const res = await upload(project.id, {
      name: "Instructions.MD",
      mimeType: "text/markdown",
      dataBase64: b64("# still reserved"),
    });

    expect(res.statusCode).toBe(400);
  });

  test("rejects base64 of a structurally-invalid length", async () => {
    const project = await seedProject("badlen");

    const res = await upload(project.id, {
      name: "x.bin",
      mimeType: "application/octet-stream",
      // 5 chars: valid alphabet but length % 4 === 1, so it can't encode bytes.
      dataBase64: "AAAAA",
    });

    expect(res.statusCode).toBe(400);
  });

  test("rejects a zero-byte payload with 400", async () => {
    const project = await seedProject("empty");

    const res = await upload(project.id, {
      name: "empty.txt",
      mimeType: "text/plain",
      // Valid-looking data: URL whose payload is empty -> decodes to 0 bytes.
      dataBase64: "data:text/plain;base64,",
    });

    expect(res.statusCode).toBe(400);
  });

  test("rejects malformed base64 with 400", async () => {
    const project = await seedProject("garbage");

    const res = await upload(project.id, {
      name: "bad.bin",
      mimeType: "application/octet-stream",
      dataBase64: "not valid base64 !!!",
    });

    expect(res.statusCode).toBe(400);
  });

  test("rejects a file over the size limit with 413", async () => {
    const project = await seedProject("toobig");

    const oversize = Buffer.alloc(MAX_PROJECT_UPLOAD_BYTES + 1, 0).toString(
      "base64",
    );
    const res = await upload(project.id, {
      name: "huge.bin",
      mimeType: "application/octet-stream",
      dataBase64: oversize,
    });

    expect(res.statusCode).toBe(413);
  });

  test("a non-member cannot upload (404, nothing written)", async ({
    makeUser,
    makeMember,
  }) => {
    const project = await seedProject("guarded");
    // Share only with the owner's org-wide read is NOT set; an outside member
    // has no access at all.
    const outsider = await makeUser({ email: "outsider-upload@test.com" });
    await makeMember(outsider.id, organizationId, {});
    actingUser = outsider;

    const res = await upload(project.id, {
      name: "sneaky.txt",
      mimeType: "text/plain",
      dataBase64: b64("data"),
    });

    expect(res.statusCode).toBe(404);
    expect(
      await FileModel.findByProjectAndName({
        organizationId,
        projectId: project.id,
        filename: "sneaky.txt",
      }),
    ).toBeNull();
  });

  test("a shared member can upload", async ({ makeUser, makeMember }) => {
    const project = await seedProject("shared");
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const member = await makeUser({ email: "shared-upload@test.com" });
    await makeMember(member.id, organizationId, {});
    actingUser = member;

    const res = await upload(project.id, {
      name: "member.txt",
      mimeType: "text/plain",
      dataBase64: b64("from a member"),
    });

    expect(res.statusCode).toBe(200);
  });

  test("a project admin with only oversight cannot upload (404, nothing written)", async ({
    makeUser,
    makeMember,
  }) => {
    // A foreign project NOT shared with the admin: oversight is read-only, so an
    // upload (a write) must be refused even though the admin can view it.
    const otherOwner = await makeUser({ email: "oversight-owner@test.com" });
    await makeMember(otherOwner.id, organizationId, {});
    const project = await projectService.create({
      organizationId,
      userId: otherOwner.id,
      name: "overseen",
      description: null,
    });

    const admin = await makeUser({ email: "oversight-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });
    actingUser = admin;

    const res = await upload(project.id, {
      name: "oversight.txt",
      mimeType: "text/plain",
      dataBase64: b64("data"),
    });

    expect(res.statusCode).toBe(404);
    expect(
      await FileModel.findByProjectAndName({
        organizationId,
        projectId: project.id,
        filename: "oversight.txt",
      }),
    ).toBeNull();
  });
});
