import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import {
  ConversationModel,
  FileModel,
  ProjectModel,
  ProjectPinModel,
  ProjectShareModel,
  ScheduleTriggerModel,
} from "@/models";
import { projectService } from "@/services/project";
import { FilesystemObjectStore } from "@/skills-sandbox/file-storage";
import { fileStore } from "@/skills-sandbox/file-store";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";

// Asserting on the orphan warning below needs the mock: the real `@/logging`
// export is a Proxy over a private pino instance, which `vi.spyOn` cannot
// intercept (see test/mocks/logging.ts).
vi.mock("@/logging");

/**
 * `projectService.purge` — permanent deletion of a project already in the
 * trash. The route is a thin wrapper (see project.routes.ts), so these exercise
 * the service; the audit record it produces is covered in
 * audit.project.route.test.ts, which needs the HTTP hook.
 */
describe("projectService.purge", () => {
  /**
   * A caller holding the built-in Admin role, which is the whole gate for
   * purging — no `project:*` permission reaches it.
   */
  const makeGlobalAdmin = async (
    organizationId: string,
    fixtures: {
      makeUser: (opts?: { email?: string }) => Promise<{ id: string }>;
      makeMember: (
        userId: string,
        orgId: string,
        opts: { role: string },
      ) => Promise<unknown>;
    },
    email: string,
  ) => {
    const admin = await fixtures.makeUser({ email });
    await fixtures.makeMember(admin.id, organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    return admin;
  };

  test("destroys the project and everything it owns, leaving its chats alone", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    makeScheduleTrigger,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const admin = await makeGlobalAdmin(
      organizationId,
      { makeUser, makeMember },
      "purge-admin@test.com",
    );

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "doomed",
      description: null,
    });
    const agent = await makeAgent({ organizationId, authorId: owner.id });

    const file = await fileStore.put({
      organizationId,
      userId: owner.id,
      projectId: project.id,
      conversationId: null,
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("abc"),
    });
    await ProjectPinModel.pin({ userId: owner.id, projectId: project.id });
    // Shared with a named colleague rather than org-wide: an org-wide project
    // needs `project:share-org` even to soft-delete, which is a different rule
    // than the one under test here.
    const colleague = await makeUser({ email: "colleague@test.com" });
    await ProjectShareModel.upsert({
      projectId: project.id,
      organizationId,
      createdByUserId: owner.id,
      visibility: "user",
      teamIds: [],
      userIds: [colleague.id],
    });
    const trigger = await makeScheduleTrigger({
      organizationId,
      actorUserId: owner.id,
      projectId: project.id,
    });
    const conversation = await ConversationModel.create({
      organizationId,
      userId: owner.id,
      agentId: agent.id,
      projectId: project.id,
      title: "a chat in the project",
    });

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });
    await projectService.purge({
      id: project.id,
      organizationId,
      userId: admin.id,
    });

    // The row itself is physically gone — not merely hidden, as the soft delete
    // left it. `findById` filters soft-deleted rows, so read the table directly.
    const rows = await db
      .select({ id: schema.projectsTable.id })
      .from(schema.projectsTable)
      .where(eq(schema.projectsTable.id, project.id));
    expect(rows).toHaveLength(0);

    // Cascade: files, pins, share config, scheduled tasks.
    expect(await FileModel.findById(file.id)).toBeNull();
    expect(await ProjectShareModel.findByProjectId(project.id)).toBeNull();
    expect(await ScheduleTriggerModel.findById(trigger.id)).toBeNull();
    const pins = await db
      .select({ projectId: schema.projectPinsTable.projectId })
      .from(schema.projectPinsTable)
      .where(eq(schema.projectPinsTable.projectId, project.id));
    expect(pins).toHaveLength(0);

    // The chat survives. It detached at soft-delete time and is an ordinary
    // conversation now — a purge must not reach through and destroy history.
    const survivors = await db
      .select({
        id: schema.conversationsTable.id,
        projectId: schema.conversationsTable.projectId,
      })
      .from(schema.conversationsTable)
      .where(eq(schema.conversationsTable.id, conversation.id));
    expect(survivors).toHaveLength(1);
    expect(survivors[0].projectId).toBeNull();
  });

  test("404s for a project that is still live — the trash is the only entry point", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const admin = await makeGlobalAdmin(
      organizationId,
      { makeUser, makeMember },
      "live-admin@test.com",
    );

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "still-here",
      description: null,
    });

    await expect(
      projectService.purge({
        id: project.id,
        organizationId,
        userId: admin.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await ProjectModel.findById(project.id)).not.toBeNull();
  });

  test("404s for a custom role holding every project permission", async ({
    makeOrganization,
    makeUser,
    makeCustomRole,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    // The broadest project role RBAC can express, `project:admin` and
    // `share-org` included, and it still stops at the trash: purging takes a
    // built-in admin role, not a permission. The refusal is indistinguishable
    // from "no such project".
    const role = await makeCustomRole(organizationId, {
      permission: {
        project: ["read", "create", "update", "delete", "admin", "share-org"],
      },
    });
    const deleter = await makeUser({ email: "deleter@test.com" });
    await makeMember(deleter.id, organizationId, { role: role.role });

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "not-yours",
      description: null,
    });
    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });

    await expect(
      projectService.purge({
        id: project.id,
        organizationId,
        userId: deleter.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    const rows = await db
      .select({ id: schema.projectsTable.id })
      .from(schema.projectsTable)
      .where(eq(schema.projectsTable.id, project.id));
    expect(rows).toHaveLength(1);
  });

  test("404s across organizations, so an admin cannot reach another tenant's trash", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const ownerOrgId = (await makeOrganization()).id;
    const otherOrgId = (await makeOrganization()).id;
    const owner = await makeUser();
    const foreignAdmin = await makeGlobalAdmin(
      otherOrgId,
      { makeUser, makeMember },
      "foreign-admin@test.com",
    );

    const project = await projectService.create({
      organizationId: ownerOrgId,
      userId: owner.id,
      name: "other-tenant",
      description: null,
    });
    await projectService.delete({
      id: project.id,
      organizationId: ownerOrgId,
      userId: owner.id,
    });

    await expect(
      projectService.purge({
        id: project.id,
        // The admin's own org is what scopes the lookup; the id belongs to
        // another one, so there is nothing to find.
        organizationId: otherOrgId,
        userId: foreignAdmin.id,
      }),
    ).rejects.toBeInstanceOf(ApiError);

    const rows = await db
      .select({ id: schema.projectsTable.id })
      .from(schema.projectsTable)
      .where(eq(schema.projectsTable.id, project.id));
    expect(rows).toHaveLength(1);
  });

  test("a restore that lands first wins, and the project survives intact", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const admin = await makeGlobalAdmin(
      organizationId,
      { makeUser, makeMember },
      "race-admin@test.com",
    );

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "contested",
      description: null,
    });
    const file = await fileStore.put({
      organizationId,
      userId: owner.id,
      projectId: project.id,
      conversationId: null,
      filename: "kept.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      data: Buffer.from("abc"),
    });
    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });

    await projectService.restore({
      id: project.id,
      organizationId,
      userId: admin.id,
    });

    // The purge now finds no soft-deleted row and reports 404 — and because the
    // byte capture and the delete share the restore-guarded transaction, the
    // project's files are untouched rather than half-destroyed.
    await expect(
      projectService.purge({
        id: project.id,
        organizationId,
        userId: admin.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });

    expect(await ProjectModel.findById(project.id)).not.toBeNull();
    expect(await FileModel.findById(file.id)).not.toBeNull();
  });
});

/**
 * Byte removal only does anything for files stored OUTSIDE Postgres. The suite
 * pins `ARCHESTRA_FILE_STORAGE_PROVIDER=db` (test/setup.ts), where the bytes
 * live in the row and die with it, so a purge test under the default provider
 * would pass without ever exercising the code that deletes them.
 */
describe("projectService.purge (filesystem provider)", () => {
  let root: string;
  let savedProvider: typeof config.fileStorage.provider;
  let savedRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "project-purge-"));
    savedProvider = config.fileStorage.provider;
    savedRoot = config.fileStorage.filesystemRoot;
    config.fileStorage.provider = "filesystem";
    config.fileStorage.filesystemRoot = root;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    config.fileStorage.provider = savedProvider;
    config.fileStorage.filesystemRoot = savedRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("removes the stored contents, not just the file records", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const admin = await makeUser({ email: "bytes-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "bytes",
      description: null,
    });
    const file = await fileStore.put({
      organizationId,
      userId: owner.id,
      projectId: project.id,
      conversationId: null,
      filename: "payload.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      data: Buffer.from("hello"),
    });
    expect(file.objectKey).not.toBeNull();
    const onDisk = path.join(root, file.objectKey as string);
    expect(await fs.readFile(onDisk, "utf8")).toBe("hello");

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });
    await projectService.purge({
      id: project.id,
      organizationId,
      userId: admin.id,
    });

    // Without the explicit capture-and-purge these bytes would survive as
    // unreachable garbage: the cascade removes the row that names them, so
    // nothing would be left pointing at the object.
    await expect(fs.readFile(onDisk, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const remaining = await db
      .select({ id: schema.filesTable.id })
      .from(schema.filesTable)
      .where(and(eq(schema.filesTable.projectId, project.id)));
    expect(remaining).toHaveLength(0);
  });

  test("still purges when the store refuses, and names the object it left behind", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const admin = await makeUser({ email: "refused-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "unreachable-store",
      description: null,
    });
    const file = await fileStore.put({
      organizationId,
      userId: owner.id,
      projectId: project.id,
      conversationId: null,
      filename: "stuck.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      data: Buffer.from("stuck"),
    });

    // The object store is down for the byte deletes only — the rows have
    // already been captured by then, so this is exactly the window that strands
    // bytes with nothing left pointing at them.
    vi.spyOn(FilesystemObjectStore.prototype, "remove").mockRejectedValue(
      new Error("object store unavailable"),
    );
    const warn = vi.mocked(logger.warn);
    warn.mockClear();

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });
    // Must NOT throw: the rows are gone by the time the store is asked, so
    // failing here would only trade leftover bytes for an unpurgeable project.
    await projectService.purge({
      id: project.id,
      organizationId,
      userId: admin.id,
    });

    const rows = await db
      .select({ id: schema.projectsTable.id })
      .from(schema.projectsTable)
      .where(eq(schema.projectsTable.id, project.id));
    expect(rows).toHaveLength(0);

    // The object key is the whole point of the warning. The `files` row naming
    // it died with the project, so once this returns the log line is the only
    // thing in the system that still knows these bytes exist — a warning
    // without the key would leave an operator nothing to clean up.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        objectKey: file.objectKey,
        provider: "filesystem",
        projectId: project.id,
      }),
      expect.stringContaining("orphaned"),
    );

    // And the purge says how many it left, so a store-wide outage is
    // distinguishable from one stubborn object.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ orphaned: 1, projectId: project.id }),
      expect.stringContaining("could not be removed"),
    );
  });

  test("leaves an object with no file row behind — a known gap, not an oversight", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const owner = await makeUser();
    const admin = await makeUser({ email: "leftovers-admin@test.com" });
    await makeMember(admin.id, organizationId, { role: ADMIN_ROLE_NAME });

    const project = await projectService.create({
      organizationId,
      userId: owner.id,
      name: "Quarterly Numbers",
      description: null,
    });

    // A file dropped straight into the project's folder, with no `files` row.
    const folder = path.join(root, project.slug);
    await fs.mkdir(folder, { recursive: true });
    const handPlaced = path.join(folder, "dropped-by-hand.txt");
    await fs.writeFile(handPlaced, "confidential");

    await projectService.delete({
      id: project.id,
      organizationId,
      userId: owner.id,
    });
    await projectService.purge({
      id: project.id,
      organizationId,
      userId: admin.id,
    });

    // Deliberate. A purge deletes by ROW, and nothing attributes this object to
    // a project: the folder is named by slug, which is shared across
    // organizations and freed for reuse by this purge. Sweeping the folder
    // would risk another tenant's bytes, so the leftover stays — as it did
    // before projects were soft-deletable and hard delete swept nothing.
    //
    // The consequence is real and accepted for now: the next project created
    // under this name inherits the folder and `fileStore.search` will surface
    // this object to whoever can see it. Fixing that means addressing the
    // slug-named folder, not re-adding a sweep here.
    expect(await fs.readFile(handPlaced, "utf8")).toBe("confidential");
  });

  test("removes only its own files when another organization shares the folder", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const orgA = (await makeOrganization()).id;
    const orgB = (await makeOrganization()).id;
    const ownerA = await makeUser({ email: "owner-a@test.com" });
    const ownerB = await makeUser({ email: "owner-b@test.com" });
    const adminA = await makeUser({ email: "tenant-admin@test.com" });
    await makeMember(adminA.id, orgA, { role: ADMIN_ROLE_NAME });

    // The slug unique index is per-organization, so two tenants that pick the
    // same project name get the SAME slug — and the object store folders
    // project files by slug alone, so both write into one folder on disk.
    const projectA = await projectService.create({
      organizationId: orgA,
      userId: ownerA.id,
      name: "Tenant Numbers",
      description: null,
    });
    const projectB = await projectService.create({
      organizationId: orgB,
      userId: ownerB.id,
      name: "Tenant Numbers",
      description: null,
    });
    expect(projectB.slug).toBe(projectA.slug);

    const fileA = await fileStore.put({
      organizationId: orgA,
      userId: ownerA.id,
      projectId: projectA.id,
      conversationId: null,
      filename: "org-a-own.txt",
      mimeType: "text/plain",
      sizeBytes: 5,
      data: Buffer.from("mine!"),
    });
    const fileB = await fileStore.put({
      organizationId: orgB,
      userId: ownerB.id,
      projectId: projectB.id,
      conversationId: null,
      filename: "org-b-secret.txt",
      mimeType: "text/plain",
      sizeBytes: 6,
      data: Buffer.from("orgB!!"),
    });
    const onDiskA = path.join(root, fileA.objectKey as string);
    const onDiskB = path.join(root, fileB.objectKey as string);

    await projectService.delete({
      id: projectA.id,
      organizationId: orgA,
      userId: ownerA.id,
    });
    await projectService.purge({
      id: projectA.id,
      organizationId: orgA,
      userId: adminA.id,
    });

    // Deleting by row is what makes a shared folder safe: each row names its
    // own bytes unambiguously. Org A's file goes; org B's is never considered,
    // so it cannot be mistaken for a leftover and destroyed.
    await expect(fs.readFile(onDiskA, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await fs.readFile(onDiskB, "utf8")).toBe("orgB!!");
    expect(await FileModel.findById(fileB.id)).not.toBeNull();
  });
});
