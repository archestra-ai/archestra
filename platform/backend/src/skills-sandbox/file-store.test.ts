import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PROJECT_INSTRUCTIONS_FILENAME } from "@archestra/shared";
import { afterEach, beforeEach } from "vitest";
import config from "@/config";
import { ProjectModel } from "@/models";
import ConversationModel from "@/models/conversation";
import FileModel, { FileNameExistsError } from "@/models/file";
import { projectService } from "@/services/project";
import { describe, expect, test } from "@/test";
import { FileNotDeletableError, fileStore } from "./file-store";

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

/** Create a conversation and return its id (no-project chats scope files to it). */
async function newConversation(params: {
  org: { id: string };
  user: { id: string };
  makeAgent: (args: { organizationId: string }) => Promise<{ id: string }>;
}): Promise<string> {
  const agent = await params.makeAgent({ organizationId: params.org.id });
  const conv = await ConversationModel.create({
    userId: params.user.id,
    organizationId: params.org.id,
    agentId: agent.id,
  });
  return conv.id;
}

describe("fileStore.put (reject-on-repeat)", () => {
  test("rejects a duplicate filename in the same conversation", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const conv = await newConversation({ org, user, makeAgent });
    await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "a.txt",
    });
    await expect(
      seed({
        organizationId: org.id,
        userId: user.id,
        conversationId: conv,
        filename: "a.txt",
      }),
    ).rejects.toBeInstanceOf(FileNameExistsError);
  });

  test("allows the same filename in two different conversations", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const convA = await newConversation({ org, user, makeAgent });
    const convB = await newConversation({ org, user, makeAgent });
    await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: convA,
      filename: "report.txt",
    });
    await expect(
      seed({
        organizationId: org.id,
        userId: user.id,
        conversationId: convB,
        filename: "report.txt",
      }),
    ).resolves.toBeTruthy();
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

  test("allows the same filename across a conversation and a project", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const conv = await newConversation({ org, user, makeAgent });
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "proj",
      description: null,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "a.txt",
    });
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
  test("conversation scope returns the conversation's files (no project files), filterable, isolated from other conversations", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const conv = await newConversation({ org, user, makeAgent });
    const otherConv = await newConversation({ org, user, makeAgent });
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "p",
      description: null,
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "own.txt",
    });
    await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "report.csv",
    });
    // another conversation's file and a project file must not appear
    await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: otherConv,
      filename: "elsewhere.txt",
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
      scope: { kind: "conversation", conversationId: conv },
    });
    expect(all.map((f) => f.filename).sort()).toEqual([
      "own.txt",
      "report.csv",
    ]);
    expect(all.every((f) => f.projectId === null)).toBe(true);

    const filtered = await fileStore.search({
      organizationId: org.id,
      userId: user.id,
      scope: { kind: "conversation", conversationId: conv },
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
  test("resolves a conversation file by id; rejects a stranger, another conversation, and a project file", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const conv = await newConversation({ org, user, makeAgent });
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "data.txt",
    });
    const convScope = { kind: "conversation", conversationId: conv } as const;

    const ok = await fileStore.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      id: file.id,
      scope: convScope,
    });
    expect("data" in ok && ok.data.toString()).toBe("abc");
    expect("originalName" in ok && ok.originalName).toBe("data.txt");

    const stranger = await makeUser({ email: "rs-stranger@test.com" });
    expect(
      await fileStore.resolveMyFileSource({
        organizationId: org.id,
        userId: stranger.id,
        id: file.id,
        scope: convScope,
      }),
    ).toEqual({ error: "not_found" });

    // the same file is unreachable from a different conversation's scope
    const otherConv = await newConversation({ org, user, makeAgent });
    expect(
      await fileStore.resolveMyFileSource({
        organizationId: org.id,
        userId: user.id,
        id: file.id,
        scope: { kind: "conversation", conversationId: otherConv },
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
        scope: convScope,
      }),
    ).toEqual({ error: "not_found" });
  });

  test("resolves by filename within the conversation; a missing name is not_found", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const conv = await newConversation({ org, user, makeAgent });
    // Per-conversation filename uniqueness (reject-on-repeat) means two
    // same-named files can't coexist in one conversation, so at most one matches.
    await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "report.txt",
    });
    const byName = await fileStore.resolveMyFileSource({
      organizationId: org.id,
      userId: user.id,
      filename: "report.txt",
      scope: { kind: "conversation", conversationId: conv },
    });
    expect("data" in byName && byName.data.toString()).toBe("abc");

    expect(
      await fileStore.resolveMyFileSource({
        organizationId: org.id,
        userId: user.id,
        filename: "nope.txt",
        scope: { kind: "conversation", conversationId: conv },
      }),
    ).toEqual({ error: "not_found" });
  });

  test("project scope: a no-project file is rejected as outside_project by id", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const conv = await newConversation({ org, user: owner, makeAgent });
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
      conversationId: conv,
      filename: "out.txt",
    });

    const ok = await fileStore.resolveMyFileSource({
      organizationId: org.id,
      userId: owner.id,
      id: inProj.id,
      scope: { kind: "project", projectId: project.id },
    });
    expect("data" in ok && ok.data.toString()).toBe("abc");

    expect(
      await fileStore.resolveMyFileSource({
        organizationId: org.id,
        userId: owner.id,
        id: personal.id,
        scope: { kind: "project", projectId: project.id },
      }),
    ).toEqual({ error: "outside_project" });
  });
});

describe("fileStore.purgeConversationFiles", () => {
  test("deletes the conversation's no-project files; keeps project files and other conversations' files", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const conv = await newConversation({ org, user, makeAgent });
    const otherConv = await newConversation({ org, user, makeAgent });
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "keep",
      description: null,
    });
    const a = await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "a.txt",
    });
    const b = await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "b.txt",
    });
    // a project file produced in the same conversation must outlive it
    const projectFile = await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      projectId: project.id,
      filename: "p.txt",
    });
    // another conversation's no-project file must be untouched
    const elsewhere = await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: otherConv,
      filename: "c.txt",
    });

    await fileStore.purgeConversationFiles({
      organizationId: org.id,
      conversationId: conv,
    });

    expect(await FileModel.findById(a.id)).toBeNull();
    expect(await FileModel.findById(b.id)).toBeNull();
    expect((await FileModel.findById(projectFile.id))?.id).toBe(projectFile.id);
    expect((await FileModel.findById(elsewhere.id))?.id).toBe(elsewhere.id);
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

  test("a conversation file lands at <email>/<conversationId>/ and edits rewrite the same key", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const conv = await newConversation({ org, user, makeAgent });
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "edit.txt",
      data: Buffer.from("v1"),
    });
    expect(file.objectKey).toBe(`${user.email}/${conv}/edit.txt`);
    const onDisk = path.join(root, user.email, conv, "edit.txt");
    expect(await fs.readFile(onDisk, "utf8")).toBe("v1");

    const updated = await fileStore.update({
      file,
      mimeType: "text/plain",
      sizeBytes: 2,
      data: Buffer.from("v2"),
    });
    expect(updated?.id).toBe(file.id);
    // edit rewrites the SAME nested key — no key drift, no orphaned sibling
    expect(updated?.objectKey).toBe(file.objectKey);
    expect(await fs.readFile(onDisk, "utf8")).toBe("v2");
    expect(await fs.readdir(path.join(root, user.email, conv))).toEqual([
      "edit.txt",
    ]);
  });

  test("a headless (no-conversation) file lands at the flat <email>/ path and edits in place", async ({
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
    expect(file.objectKey).toBe(`${user.email}/edit.txt`);
    const onDisk = path.join(root, user.email, "edit.txt");
    expect(await fs.readFile(onDisk, "utf8")).toBe("v1");

    const updated = await fileStore.update({
      file,
      mimeType: "text/plain",
      sizeBytes: 2,
      data: Buffer.from("v2"),
    });
    expect(updated?.id).toBe(file.id);
    expect(updated?.objectKey).toBe(file.objectKey);
    expect(await fs.readFile(onDisk, "utf8")).toBe("v2");
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

  test("get() denies a user obj_ ref whose key is a sibling folder; the owner reads its own", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    await drop(owner.email, "private.txt", "secret");
    const userRef = (userId: string, key: string) =>
      `obj_${Buffer.from(
        JSON.stringify({ s: { kind: "user", userId }, k: key }),
        "utf8",
      ).toString("base64url")}`;

    // a well-formed ref for the ATTACKER's own scope, but with the OWNER's key —
    // no traversal, just a sibling folder under the shared root. The key must
    // belong to the caller's own folder (verified by enumeration), so it fails.
    const attacker = await makeUser({ email: "ref-attacker@test.com" });
    expect(
      await fileStore.get({
        ref: userRef(attacker.id, `${owner.email}/private.txt`),
        organizationId: org.id,
        userId: attacker.id,
      }),
    ).toBeNull();
    // control: the owner reads its own hand-placed file via its own ref
    const got = await fileStore.get({
      ref: userRef(owner.id, `${owner.email}/private.txt`),
      organizationId: org.id,
      userId: owner.id,
    });
    expect(got?.data.toString()).toBe("secret");
  });

  test("delete denies a user obj_ ref whose key is a sibling folder (no arbitrary delete)", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    await drop(owner.email, "private.txt", "secret");
    const attacker = await makeUser({ email: "del-ref-attacker@test.com" });
    // a well-formed ref for the ATTACKER's own scope, but with the OWNER's key.
    // delete must bind the key to the caller's scope (like get) and refuse it.
    const crafted = `obj_${Buffer.from(
      JSON.stringify({
        s: { kind: "user", userId: attacker.id },
        k: `${owner.email}/private.txt`,
      }),
      "utf8",
    ).toString("base64url")}`;
    expect(
      await fileStore.delete({
        ref: crafted,
        organizationId: org.id,
        userId: attacker.id,
      }),
    ).toBe(false);
    // the owner's bytes are still on disk and readable
    expect(
      await fs.readFile(path.join(root, owner.email, "private.txt"), "utf8"),
    ).toBe("secret");
  });

  test("purgeConversationFiles removes the conversation's no-project bytes from disk", async ({
    makeUser,
    makeOrganization,
    makeAgent,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const conv = await newConversation({ org, user, makeAgent });
    const file = await seed({
      organizationId: org.id,
      userId: user.id,
      conversationId: conv,
      filename: "out.txt",
      data: Buffer.from("bytes"),
    });
    const onDisk = path.join(root, user.email, conv, "out.txt");
    expect(await fs.readFile(onDisk, "utf8")).toBe("bytes");

    await fileStore.purgeConversationFiles({
      organizationId: org.id,
      conversationId: conv,
    });

    expect(await FileModel.findById(file.id)).toBeNull();
    await expect(fs.readFile(onDisk, "utf8")).rejects.toThrow();
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

  test("an obj_ ref is denied to a user who is not its owner", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    await drop(owner.email, "private.txt", "secret");
    // the owner's real ref, replayed by a stranger — scope ACL must deny it.
    const ref = `obj_${Buffer.from(
      JSON.stringify({
        s: { kind: "user", userId: owner.id },
        k: `${owner.email}/private.txt`,
      }),
      "utf8",
    ).toString("base64url")}`;
    const stranger = await makeUser({ email: "ref-stranger@test.com" });
    expect(
      await fileStore.get({
        ref,
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
      // a crafted ref to the symlink reads as null, not a thrown error
      const ref = `obj_${Buffer.from(JSON.stringify({ s: { kind: "user", userId: user.id }, k: `${user.email}/ln.txt` }), "utf8").toString("base64url")}`;
      expect(
        await fileStore.get({ ref, organizationId: org.id, userId: user.id }),
      ).toBeNull();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("the instructions file cannot be deleted via an obj_ ref to its bytes", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "instr-obj",
      description: null,
    });
    await fileStore.writeProjectInstructions({
      organizationId: org.id,
      userId: user.id,
      projectId: project.id,
      content: "keep me",
    });
    const row = await FileModel.findByProjectAndName({
      organizationId: org.id,
      projectId: project.id,
      filename: PROJECT_INSTRUCTIONS_FILENAME,
    });
    expect(row?.objectKey).toBeTruthy();

    // A crafted obj_ ref addressing the instructions bytes directly must be
    // refused too — otherwise it would orphan the row (bytes gone, unreadable).
    const ref = `obj_${Buffer.from(
      JSON.stringify({
        s: { kind: "project", projectId: project.id },
        k: row?.objectKey,
      }),
      "utf8",
    ).toString("base64url")}`;
    await expect(
      fileStore.delete({ ref, organizationId: org.id, userId: user.id }),
    ).rejects.toBeInstanceOf(FileNotDeletableError);

    // bytes + row still intact
    expect(
      await fileStore.readProjectInstructions({
        organizationId: org.id,
        projectId: project.id,
      }),
    ).toBe("keep me");
  });
});

describe("fileStore project instructions", () => {
  async function makeProject(org: { id: string }, user: { id: string }) {
    return ProjectModel.create({
      organizationId: org.id,
      userId: user.id,
      name: "proj",
      description: null,
    });
  }

  test("read returns null until the file is written", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await makeProject(org, user);
    expect(
      await fileStore.readProjectInstructions({
        organizationId: org.id,
        projectId: project.id,
      }),
    ).toBeNull();
  });

  test("write creates the file, then upserts it (empty is kept)", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await makeProject(org, user);
    const read = () =>
      fileStore.readProjectInstructions({
        organizationId: org.id,
        projectId: project.id,
      });

    await fileStore.writeProjectInstructions({
      organizationId: org.id,
      userId: user.id,
      projectId: project.id,
      content: "# Rules\nBe concise.",
    });
    expect(await read()).toBe("# Rules\nBe concise.");

    await fileStore.writeProjectInstructions({
      organizationId: org.id,
      userId: user.id,
      projectId: project.id,
      content: "updated",
    });
    expect(await read()).toBe("updated");

    // Emptying keeps an empty real file (read is "", not null).
    await fileStore.writeProjectInstructions({
      organizationId: org.id,
      userId: user.id,
      projectId: project.id,
      content: "",
    });
    expect(await read()).toBe("");
  });

  test("the instructions file cannot be deleted", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await makeProject(org, user);
    await fileStore.writeProjectInstructions({
      organizationId: org.id,
      userId: user.id,
      projectId: project.id,
      content: "hi",
    });
    const row = await FileModel.findByProjectAndName({
      organizationId: org.id,
      projectId: project.id,
      filename: PROJECT_INSTRUCTIONS_FILENAME,
    });
    expect(row).not.toBeNull();
    await expect(
      fileStore.delete({
        ref: row?.id ?? "",
        organizationId: org.id,
        userId: user.id,
      }),
    ).rejects.toBeInstanceOf(FileNotDeletableError);
  });

  test("the instructions file IS listed like any other project file", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const project = await makeProject(org, user);
    await fileStore.writeProjectInstructions({
      organizationId: org.id,
      userId: user.id,
      projectId: project.id,
      content: "hi",
    });
    const listed = await fileStore.search({
      organizationId: org.id,
      userId: user.id,
      scope: { kind: "project", projectId: project.id, projectName: "proj" },
    });
    expect(listed.map((f) => f.filename)).toContain(
      PROJECT_INSTRUCTIONS_FILENAME,
    );
  });
});
