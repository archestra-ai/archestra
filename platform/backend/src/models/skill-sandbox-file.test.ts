import SkillSandboxModel from "@/models/skill-sandbox";
import SkillSandboxFileModel from "@/models/skill-sandbox-file";
import { expect, test } from "@/test";

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
    path: "/home/sandbox/chart.png",
    mimeType: "image/png",
    sizeBytes: 3,
    data: Buffer.from("abc"),
  });
  const second = await SkillSandboxFileModel.createArtifact({
    sandboxId: sandbox.id,
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
