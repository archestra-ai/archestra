import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach } from "vitest";
import config from "@/config";
import { ProjectModel } from "@/models";
import ConversationModel from "@/models/conversation";
import { FileNameExistsError } from "@/models/file";
import { projectService } from "@/services/project";
import { describe, expect, test } from "@/test";
import { fileStore } from "./file-store";

async function seed(params: {
  organizationId: string;
  userId: string;
  filename: string;
  projectId?: string | null;
  conversationId?: string | null;
  data?: Buffer;
}) {
  return fileStore.put({
    organizationId: params.organizationId,
    userId: params.userId,
    projectId: params.projectId ?? null,
    conversationId: params.conversationId ?? null,
    filename: params.filename,
    mimeType: "text/plain",
    sizeBytes: (params.data ?? Buffer.from("abc")).byteLength,
    data: params.data ?? Buffer.from("abc"),
  });
}

describe("fileStore.put (reject-on-repeat)", () => {
  test("rejects a duplicate filename for the same user (personal scope)", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await seed({ organizationId: org.id, userId: user.id, filename: "a.txt" });
    await expect(
      seed({ organizationId: org.id, userId: user.id, filename: "a.txt" }),
    ).rejects.toBeInstanceOf(FileNameExistsError);
  });

  test("rejects a duplicate filename within the same project", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "proj",
      description: null,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "a.txt",
      projectId: project.id,
    });
    await expect(
      seed({
        organizationId: org.id,
        userId: user.id,
        filename: "a.txt",
        projectId: project.id,
      }),
    ).rejects.toBeInstanceOf(FileNameExistsError);
  });

  test("allows the same filename across different scopes", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "proj",
      description: null,
    });
    // personal + project may both hold "a.txt"
    await seed({ organizationId: org.id, userId: user.id, filename: "a.txt" });
    await expect(
      seed({
        organizationId: org.id,
        userId: user.id,
        filename: "a.txt",
        projectId: project.id,
      }),
    ).resolves.toBeTruthy();
  });
});

describe("fileStore.search", () => {
  test("personal scope returns the user's own files (no project files), filterable", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "p",
      description: null,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "own.txt",
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "report.csv",
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "proj.txt",
      projectId: project.id,
    });

    const all = await fileStore.search({
      organizationId: org.id,
      userId: user.id,
      scope: { kind: "personal" },
    });
    expect(all.map((f) => f.filename).sort()).toEqual([
      "own.txt",
      "report.csv",
    ]);
    expect(all.every((f) => f.projectId === null)).toBe(true);

    const filtered = await fileStore.search({
      organizationId: org.id,
      userId: user.id,
      scope: { kind: "personal" },
      query: "report",
    });
    expect(filtered.map((f) => f.filename)).toEqual(["report.csv"]);
  });

  test("project scope returns the project's files tagged with the project name", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "Demo",
      description: null,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "r.txt",
      projectId: project.id,
    });

    const files = await fileStore.search({
      organizationId: org.id,
      userId: user.id,
      scope: {
        kind: "project",
        projectId: project.id,
        projectName: project.name,
      },
    });
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      filename: "r.txt",
      projectId: project.id,
      projectName: "Demo",
      downloadable: true,
    });
  });
});

describe("fileStore.list (by conversation)", () => {
  test("any-author lists the conversation's files oldest-first", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conv = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "first.txt",
      conversationId: conv.id,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "second.txt",
      conversationId: conv.id,
    });

    const items = await fileStore.list({
      organizationId: org.id,
      conversationId: conv.id,
    });
    expect(items.map((f) => f.filename).sort()).toEqual([
      "first.txt",
      "second.txt",
    ]);
    // ordered oldest-first by createdAt (tie-broken by id)
    expect(items[0].createdAt.getTime()).toBeLessThanOrEqual(
      items[1].createdAt.getTime(),
    );
    expect(items[0].downloadable).toBe(true);
  });

  test("author-scoped lists only that author's files in the conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const agent = await makeAgent({ organizationId: org.id });
    const conv = await ConversationModel.create({
      userId: user.id,
      organizationId: org.id,
      agentId: agent.id,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "mine.txt",
      conversationId: conv.id,
    });

    const items = await fileStore.list({
      organizationId: org.id,
      conversationId: conv.id,
      authorUserId: user.id,
    });
    expect(items.map((f) => f.filename)).toEqual(["mine.txt"]);
  });
});

describe("fileStore.get access", () => {
  test("author sees own personal file (with bytes); a stranger does not", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "secret.txt",
    });

    const seen = await fileStore.get({
      ref: file.id,
      organizationId: org.id,
      userId: user.id,
    });
    expect(seen?.id).toBe(file.id);
    expect(seen?.data.toString()).toBe("abc");

    const stranger = await makeUser({ email: "stranger@test.com" });
    expect(
      await fileStore.get({
        ref: file.id,
        organizationId: org.id,
        userId: stranger.id,
      }),
    ).toBeNull();
  });

  test("project file: a member is allowed, a cross-org user is denied", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "shared",
      description: null,
    });
    await projectService.setShare({
      id: project.id,
      organizationId: org.id,
      userId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    const file = await seed({
      organizationId: org.id,
      userId: owner.id,
      filename: "r.txt",
      projectId: project.id,
    });

    const member = await makeUser({ email: "proj-member@test.com" });
    const seen = await fileStore.get({
      ref: file.id,
      organizationId: org.id,
      userId: member.id,
    });
    expect(seen?.id).toBe(file.id);

    const otherOrg = await makeOrganization();
    const outsider = await makeUser({ email: "cross-org@test.com" });
    expect(
      await fileStore.get({
        ref: file.id,
        organizationId: otherOrg.id,
        userId: outsider.id,
      }),
    ).toBeNull();
  });

  test("project file: a user with no project access is denied; the owner is allowed", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "owner-only",
      description: null,
    });
    const file = await seed({
      organizationId: org.id,
      userId: owner.id,
      filename: "r.txt",
      projectId: project.id,
    });

    const nonMember = await makeUser({ email: "non-member@test.com" });
    expect(
      await fileStore.get({
        ref: file.id,
        organizationId: org.id,
        userId: nonMember.id,
      }),
    ).toBeNull();
    const seenByOwner = await fileStore.get({
      ref: file.id,
      organizationId: org.id,
      userId: owner.id,
    });
    expect(seenByOwner?.id).toBe(file.id);
  });
});

describe("fileStore.delete", () => {
  test("the author can delete their file; afterwards it is gone", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "del.txt",
    });
    expect(
      await fileStore.delete({
        ref: file.id,
        organizationId: org.id,
        userId: user.id,
      }),
    ).toBe(true);
    expect(
      await fileStore.get({
        ref: file.id,
        organizationId: org.id,
        userId: user.id,
      }),
    ).toBeNull();
  });

  test("a stranger cannot delete another user's file", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "keep.txt",
    });
    const stranger = await makeUser({ email: "del-stranger@test.com" });
    expect(
      await fileStore.delete({
        ref: file.id,
        organizationId: org.id,
        userId: stranger.id,
      }),
    ).toBe(false);
  });
});

describe("fileStore.resolveMyFileSource", () => {
  test("resolves a personal file by id; rejects a stranger and a project file", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "data.txt",
    });

    const ok = await fileStore.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      id: file.id,
    });
    expect("data" in ok && ok.data.toString()).toBe("abc");
    expect("originalName" in ok && ok.originalName).toBe("data.txt");

    const stranger = await makeUser({ email: "rs-stranger@test.com" });
    expect(
      await fileStore.resolveMyFileSource({
        organizationId: org.id,
        userId: stranger.id,
        id: file.id,
      }),
    ).toEqual({ error: "not_found" });

    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "pp",
      description: null,
    });
    const projFile = await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "p.txt",
      projectId: project.id,
    });
    expect(
      await fileStore.resolveMyFileSource({
        organizationId: org.id,
        userId: user.id,
        id: projFile.id,
      }),
    ).toEqual({ error: "not_found" });
  });

  test("resolves by filename; a missing name is not_found", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    // Per-scope filename uniqueness (reject-on-repeat) means two same-named
    // files can't coexist in one scope, so the resolver finds at most one.
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "report.txt",
    });
    const byName = await fileStore.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      filename: "report.txt",
    });
    expect("data" in byName && byName.data.toString()).toBe("abc");

    expect(
      await fileStore.resolveMyFileSource({
        organizationId: org.id,
        userId: user.id,
        filename: "nope.txt",
      }),
    ).toEqual({ error: "not_found" });
  });

  test("project scope: a personal file is rejected as outside_project by id", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "scope-proj",
      description: null,
    });
    const inProj = await seed({
      organizationId: org.id,
      userId: owner.id,
      filename: "in.txt",
      projectId: project.id,
    });
    const personal = await seed({
      organizationId: org.id,
      userId: owner.id,
      filename: "out.txt",
    });

    const ok = await fileStore.resolveMyFileSource({
      organizationId: org.id,
      userId: owner.id,
      id: inProj.id,
      scope: { projectId: project.id },
    });
    expect("data" in ok && ok.data.toString()).toBe("abc");

    expect(
      await fileStore.resolveMyFileSource({
        organizationId: org.id,
        userId: owner.id,
        id: personal.id,
        scope: { projectId: project.id },
      }),
    ).toEqual({ error: "outside_project" });
  });
});

describe("fileStore disk overlay (filesystem provider)", () => {
  let root: string;
  let savedProvider: typeof config.fileStorage.provider;
  let savedRoot: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "fstore-overlay-"));
    savedProvider = config.fileStorage.provider;
    savedRoot = config.fileStorage.filesystemRoot;
    config.fileStorage.provider = "filesystem";
    config.fileStorage.filesystemRoot = root;
  });
  afterEach(async () => {
    config.fileStorage.provider = savedProvider;
    config.fileStorage.filesystemRoot = savedRoot;
    await fs.rm(root, { recursive: true, force: true });
  });

  async function drop(folder: string, name: string, content: string) {
    const dir = path.join(root, folder);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }

  test("search surfaces a hand-dropped personal file and dedups written ones", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "written.txt",
    });
    await drop(user.email, "dropped.txt", "hello");

    const items = await fileStore.search({
      organizationId: org.id,
      userId: user.id,
      scope: { kind: "personal" },
    });
    const byName = new Map(items.map((i) => [i.filename, i]));
    expect(byName.get("written.txt")?.id).not.toBeNull();
    const dropped = byName.get("dropped.txt");
    expect(dropped?.id).toBeNull();
    expect(dropped?.downloadRef.startsWith("obj_")).toBe(true);
    // the written file (row + disk) is listed once, not doubled by the overlay
    expect(items.filter((i) => i.filename === "written.txt")).toHaveLength(1);
  });

  test("get() denies a ref whose key points outside its own scope", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    await drop(owner.email, "private.txt", "secret");
    const attacker = await makeUser({ email: "ref-attacker@test.com" });
    // a well-formed ref for the ATTACKER's own scope, but with the OWNER's key —
    // no traversal, just a sibling folder under the shared root.
    const crafted = `obj_${Buffer.from(
      JSON.stringify({
        s: { kind: "user", userId: attacker.id },
        k: `${owner.email}/private.txt`,
      }),
      "utf8",
    ).toString("base64url")}`;
    expect(
      await fileStore.get({
        ref: crafted,
        organizationId: org.id,
        userId: attacker.id,
      }),
    ).toBeNull();
    // control: the owner reads it via the real ref from search
    const [item] = await fileStore.search({
      organizationId: org.id,
      userId: owner.id,
      scope: { kind: "personal" },
    });
    const got = await fileStore.get({
      ref: item.downloadRef,
      organizationId: org.id,
      userId: owner.id,
    });
    expect(got?.data.toString()).toBe("secret");
  });

  test("resolveMyFileSource resolves a hand-placed file by ref, scope-confined", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await drop(user.email, "notes.txt", "by ref");
    const [item] = await fileStore.search({
      organizationId: org.id,
      userId: user.id,
      scope: { kind: "personal" },
    });
    expect(item.id).toBeNull(); // hand-placed → addressable only by ref

    const ok = await fileStore.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      id: item.downloadRef,
      scope: null,
    });
    expect("error" in ok).toBe(false);
    expect((ok as { data: Buffer }).data.toString()).toBe("by ref");

    // a project chat cannot resolve a personal ref (owner scope is the project)
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "Other",
      description: null,
    });
    const denied = await fileStore.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      id: item.downloadRef,
      scope: { projectId: project.id },
    });
    expect(denied).toEqual({ error: "not_found" });
  });

  test("update replaces a filesystem-backed file's bytes in place (edit_file)", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      filename: "edit.txt",
      data: Buffer.from("v1"),
    });
    const onDisk = path.join(root, user.email, "edit.txt");
    expect(await fs.readFile(onDisk, "utf8")).toBe("v1");

    const updated = await fileStore.update({
      file,
      mimeType: "text/plain",
      sizeBytes: 2,
      data: Buffer.from("v2"),
    });
    expect(updated?.id).toBe(file.id); // same row id + filename, new bytes
    expect(await fs.readFile(onDisk, "utf8")).toBe("v2");
    const got = await fileStore.get({
      ref: file.id,
      organizationId: org.id,
      userId: user.id,
    });
    expect(got?.data.toString()).toBe("v2");
  });

  test("a project rename does not move its files (folder is the immutable slug)", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "Quarterly Report",
      description: null,
    });
    const { slug } = project;
    const file = await seed({
      organizationId: org.id,
      userId: owner.id,
      filename: "report.txt",
      projectId: project.id,
      data: Buffer.from("body"),
    });
    // bytes land under <root>/<slug>/, not <root>/<name>/
    expect(await fs.readFile(path.join(root, slug, "report.txt"), "utf8")).toBe(
      "body",
    );

    await ProjectModel.update({
      id: project.id,
      fields: { name: "Annual Report" },
    });
    const renamed = await ProjectModel.findById(project.id);
    expect(renamed?.name).toBe("Annual Report");
    expect(renamed?.slug).toBe(slug); // slug is immutable across a rename

    // the file still reads and its on-disk folder is unchanged
    const got = await fileStore.get({
      ref: file.id,
      organizationId: org.id,
      userId: owner.id,
    });
    expect(got?.data.toString()).toBe("body");
    expect(await fs.readdir(path.join(root, slug))).toContain("report.txt");
  });

  test("get/delete a disk-only file by ref, gated by folder access", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await drop(user.email, "dropped.txt", "payload");
    const [item] = await fileStore.search({
      organizationId: org.id,
      userId: user.id,
      scope: { kind: "personal" },
    });
    const ref = item.downloadRef;

    const got = await fileStore.get({
      ref,
      organizationId: org.id,
      userId: user.id,
    });
    expect(got?.id).toBeNull();
    expect(got?.data.toString()).toBe("payload");

    const stranger = await makeUser({ email: "overlay-stranger@test.com" });
    expect(
      await fileStore.get({ ref, organizationId: org.id, userId: stranger.id }),
    ).toBeNull();
    expect(
      await fileStore.delete({
        ref,
        organizationId: org.id,
        userId: stranger.id,
      }),
    ).toBe(false);

    expect(
      await fileStore.delete({ ref, organizationId: org.id, userId: user.id }),
    ).toBe(true);
    const after = await fileStore.search({
      organizationId: org.id,
      userId: user.id,
      scope: { kind: "personal" },
    });
    expect(after.find((i) => i.filename === "dropped.txt")).toBeUndefined();
  });

  test("a disk-only file in a project folder follows project access", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: owner.id,
      name: "DiskProj",
      description: null,
    });
    await projectService.setShare({
      id: project.id,
      organizationId: org.id,
      userId: owner.id,
      visibility: "organization",
      teamIds: [],
    });
    // the project's folder is its immutable slug, not its display name.
    await drop(project.slug, "shared.txt", "data");

    const member = await makeUser({ email: "overlay-member@test.com" });
    const items = await fileStore.search({
      organizationId: org.id,
      userId: member.id,
      scope: {
        kind: "project",
        projectId: project.id,
        projectName: project.name,
      },
    });
    const found = items.find((i) => i.filename === "shared.txt");
    expect(found?.downloadRef.startsWith("obj_")).toBe(true);
    const got = await fileStore.get({
      ref: found?.downloadRef ?? "",
      organizationId: org.id,
      userId: member.id,
    });
    expect(got?.data.toString()).toBe("data");

    const otherOrg = await makeOrganization();
    const outsider = await makeUser({ email: "overlay-outsider@test.com" });
    expect(
      await fileStore.get({
        ref: found?.downloadRef ?? "",
        organizationId: otherOrg.id,
        userId: outsider.id,
      }),
    ).toBeNull();
  });

  test("crafted/adversarial obj_ refs resolve to null, never an error", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    // a well-formed ref for THIS user, but with a malicious object key.
    const craftKey = (key: string) =>
      `obj_${Buffer.from(JSON.stringify({ s: { kind: "user", userId: user.id }, k: key }), "utf8").toString("base64url")}`;

    for (const key of [
      "../../etc/passwd", // traversal
      `${user.email}/../../etc/passwd`, // traversal under a real folder
      `${user.email}/.hidden`, // leading-dot segment
    ]) {
      expect(
        await fileStore.get({
          ref: craftKey(key),
          organizationId: org.id,
          userId: user.id,
        }),
      ).toBeNull();
    }
    // malformed refs are just "not found": bad base64, bad json, bad shape.
    for (const ref of [
      "obj_!!!notbase64!!!",
      `obj_${Buffer.from("not json", "utf8").toString("base64url")}`,
      `obj_${Buffer.from(JSON.stringify({ s: { kind: "nope" }, k: "x" }), "utf8").toString("base64url")}`,
    ]) {
      expect(
        await fileStore.get({ ref, organizationId: org.id, userId: user.id }),
      ).toBeNull();
    }
  });

  test("an obj_ ref for another user's scope is denied", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    await drop(owner.email, "private.txt", "secret");
    const [item] = await fileStore.search({
      organizationId: org.id,
      userId: owner.id,
      scope: { kind: "personal" },
    });
    const stranger = await makeUser({ email: "ref-stranger@test.com" });
    // the stranger replays the owner's real ref — scope ACL must deny it.
    expect(
      await fileStore.get({
        ref: item.downloadRef,
        organizationId: org.id,
        userId: stranger.id,
      }),
    ).toBeNull();
  });

  test("a symlinked object reads as not-found (no 500)", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fstore-leak-"));
    await fs.writeFile(path.join(outside, "secret"), "leak");
    const folderDir = path.join(root, user.email);
    await fs.mkdir(folderDir, { recursive: true });
    await fs.symlink(
      path.join(outside, "secret"),
      path.join(folderDir, "ln.txt"),
    );
    try {
      // symlinks aren't surfaced by search
      const listed = await fileStore.search({
        organizationId: org.id,
        userId: user.id,
        scope: { kind: "personal" },
      });
      expect(listed.find((i) => i.filename === "ln.txt")).toBeUndefined();
      // a crafted ref to it reads as null, not a thrown error
      const ref = `obj_${Buffer.from(JSON.stringify({ s: { kind: "user", userId: user.id }, k: `${user.email}/ln.txt` }), "utf8").toString("base64url")}`;
      expect(
        await fileStore.get({ ref, organizationId: org.id, userId: user.id }),
      ).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
