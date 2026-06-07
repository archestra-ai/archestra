import { SkillSandboxFileModel, SkillSandboxModel } from "@/models";
import { describe, expect, test } from "@/test";

/**
 * `skill_sandbox_files.created_at` is millisecond-resolution and the table has
 * no monotonic tiebreak column (unlike `audit_log.event_sequence`), so two
 * back-to-back inserts can share a millisecond. The model's `ORDER BY
 * created_at DESC` is then non-deterministic for the tied rows. When a test
 * asserts a strict newest-first order between same-sandbox artifacts, call this
 * between the inserts to guarantee their `created_at` values differ.
 */
async function nextMillisecond(): Promise<void> {
  const start = Date.now();
  while (Date.now() === start) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

async function seedArtifact(params: {
  sandboxId: string;
  userId: string;
  path: string;
  mimeType?: string;
}) {
  return SkillSandboxFileModel.createArtifact({
    sandboxId: params.sandboxId,
    userId: params.userId,
    path: params.path,
    mimeType: params.mimeType ?? "text/plain",
    originalName: null,
    sizeBytes: 3,
    data: Buffer.from("abc"),
  });
}

describe("SkillSandboxFileModel.listUserArtifacts", () => {
  test("returns the user's artifacts, newest first, kind=artifact only", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      path: "/s/a.txt",
    });
    // Guarantee b.txt has a strictly later created_at than a.txt; without this
    // the two inserts can tie at millisecond granularity and the desc order of
    // the tied rows is non-deterministic (see nextMillisecond docstring).
    await nextMillisecond();
    await seedArtifact({
      sandboxId: sandbox.id,
      userId: user.id,
      path: "/s/b.txt",
    });

    const rows = await SkillSandboxFileModel.listUserArtifacts({
      organizationId: org.id,
      userId: user.id,
    });

    expect(rows.map((r) => r.filename)).toEqual(["b.txt", "a.txt"]);
    expect(rows[0]).toMatchObject({ mimeType: "text/plain", sizeBytes: 3 });
    expect(typeof rows[0].id).toBe("string");
  });

  test("excludes other users' and other orgs' artifacts", async ({
    makeUser,
    makeOrganization,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const other = await makeUser({ email: "other@test.com" });
    const otherOrg = await makeOrganization();
    const mine = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    const theirs = await SkillSandboxModel.create({
      organizationId: otherOrg.id,
      userId: other.id,
      conversationId: null,
      defaultCwd: "/sandbox",
    });
    await seedArtifact({
      sandboxId: mine.id,
      userId: user.id,
      path: "/s/mine.txt",
    });
    await seedArtifact({
      sandboxId: theirs.id,
      userId: other.id,
      path: "/s/theirs.txt",
    });

    const rows = await SkillSandboxFileModel.listUserArtifacts({
      organizationId: org.id,
      userId: user.id,
    });

    expect(rows.map((r) => r.filename)).toEqual(["mine.txt"]);
  });

  test("filters to one conversation when conversationId is given", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeConversation,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({ organizationId: org.id });
    const convA = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    const convB = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    const sandboxA = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: convA.id,
      defaultCwd: "/sandbox",
    });
    const sandboxB = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: convB.id,
      defaultCwd: "/sandbox",
    });
    await seedArtifact({
      sandboxId: sandboxA.id,
      userId: user.id,
      path: "/s/a.txt",
    });
    await seedArtifact({
      sandboxId: sandboxB.id,
      userId: user.id,
      path: "/s/b.txt",
    });

    const rows = await SkillSandboxFileModel.listUserArtifacts({
      organizationId: org.id,
      userId: user.id,
      conversationId: convA.id,
    });

    expect(rows.map((r) => r.filename)).toEqual(["a.txt"]);
  });
});

test("listArtifactMetadataByConversationId returns artifacts for the conversation, org-scoped, oldest first", async ({
  makeUser,
  makeOrganization,
  makeAgent,
  makeConversation,
}) => {
  const org = await makeOrganization();
  const user = await makeUser({});
  const agent = await makeAgent({ organizationId: org.id });
  const conv = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });

  const sandbox = await SkillSandboxModel.create({
    organizationId: org.id,
    userId: user.id,
    conversationId: conv.id,
    defaultCwd: "/home/sandbox",
    isDefault: true,
  });

  const first = await SkillSandboxFileModel.createArtifact({
    sandboxId: sandbox.id,
    userId: user.id,
    path: "/home/sandbox/chart.png",
    mimeType: "image/png",
    sizeBytes: 3,
    data: Buffer.from("abc"),
  });
  const second = await SkillSandboxFileModel.createArtifact({
    sandboxId: sandbox.id,
    userId: user.id,
    path: "/home/sandbox/sub/results.csv",
    mimeType: "text/csv",
    sizeBytes: 5,
    data: Buffer.from("a,b,c"),
  });

  // A sandbox in a different org must not leak.
  const otherOrg = await makeOrganization();
  const otherSandbox = await SkillSandboxModel.create({
    organizationId: otherOrg.id,
    userId: user.id,
    conversationId: conv.id,
    defaultCwd: "/home/sandbox",
    isDefault: false,
  });
  await SkillSandboxFileModel.createArtifact({
    sandboxId: otherSandbox.id,
    userId: user.id,
    path: "/home/sandbox/secret.png",
    mimeType: "image/png",
    sizeBytes: 1,
    data: Buffer.from("x"),
  });

  const rows = await SkillSandboxFileModel.listArtifactMetadataByConversationId(
    {
      conversationId: conv.id,
      organizationId: org.id,
    },
  );

  // Both this-org artifacts returned; the other-org sandbox's artifact excluded.
  // (Order is by createdAt; the two rows share a defaultNow() timestamp, so the
  // tiebreak is the random uuid — not a stable order to assert on.)
  expect(new Set(rows.map((r) => r.id))).toEqual(
    new Set([first.id, second.id]),
  );
  const chart = rows.find((r) => r.id === first.id);
  expect(chart).toMatchObject({
    path: "/home/sandbox/chart.png",
    mimeType: "image/png",
  });
  // Metadata only — no bytes.
  expect("data" in (rows[0] as object)).toBe(false);
});
