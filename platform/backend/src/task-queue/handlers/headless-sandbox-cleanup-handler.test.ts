import { eq, sql } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import {
  FileModel,
  SkillSandboxModel,
  SkillSandboxReplayEventModel,
} from "@/models";
import { fileStore } from "@/skills-sandbox/file-store";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { handleHeadlessSandboxCleanup } from "./headless-sandbox-cleanup-handler";

const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);
const originalRetentionDays = config.skillsSandbox.headlessRetentionDays;

async function backdateSandbox(sandboxId: string, createdAt: Date) {
  await db
    .update(schema.skillSandboxesTable)
    .set({ createdAt })
    .where(eq(schema.skillSandboxesTable.id, sandboxId));
}

// Stamps the age the way column defaults do: relative to the database's now().
async function backdateInDatabaseClock(sandboxId: string, age: string) {
  await db
    .update(schema.skillSandboxesTable)
    .set({ createdAt: sql`now()::timestamp - ${age}::interval` })
    .where(eq(schema.skillSandboxesTable.id, sandboxId));
}

async function appendCommandAt(
  sandboxId: string,
  organizationId: string,
  createdAt: Date,
) {
  await SkillSandboxReplayEventModel.appendCommand({
    sandboxId,
    organizationId,
    command: "echo hi",
    cwd: null,
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 1,
    timeoutSeconds: 30,
  });
  await db
    .update(schema.skillSandboxReplayEventsTable)
    .set({ createdAt })
    .where(eq(schema.skillSandboxReplayEventsTable.sandboxId, sandboxId));
}

describe("handleHeadlessSandboxCleanup", () => {
  beforeEach(() => {
    config.skillsSandbox.headlessRetentionDays = 7;
  });
  afterEach(() => {
    config.skillsSandbox.headlessRetentionDays = originalRetentionDays;
  });

  test("deletes a stale headless sandbox with its replay log; exported files survive", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    await appendCommandAt(sandbox.id, org.id, daysAgo(10));
    const file = await fileStore.put({
      organizationId: org.id,
      userId: user.id,
      projectId: null,
      conversationId: null,
      sandboxId: sandbox.id,
      filename: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      data: Buffer.from("a"),
    });
    await backdateSandbox(sandbox.id, daysAgo(10));

    await handleHeadlessSandboxCleanup();

    expect(await SkillSandboxModel.findById(sandbox.id)).toBeNull();
    expect(
      await SkillSandboxReplayEventModel.listBySandbox(sandbox.id),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.skillSandboxCommandsTable)
        .where(eq(schema.skillSandboxCommandsTable.sandboxId, sandbox.id)),
    ).toHaveLength(0);
    expect((await FileModel.findById(file.id))?.sandboxId).toBeNull();
  });

  test("keeps recent, recently active, conversation, and app sandboxes", async ({
    makeOrganization,
    makeUser,
    makeAgent,
    makeConversation,
    makeApp,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const base = {
      organizationId: org.id,
      userId: user.id,
      defaultCwd: "/home/sandbox",
    };

    const recent = await SkillSandboxModel.create({
      ...base,
      conversationId: null,
    });
    await backdateSandbox(recent.id, daysAgo(3));

    const active = await SkillSandboxModel.create({
      ...base,
      conversationId: null,
    });
    await appendCommandAt(active.id, org.id, daysAgo(1));
    await backdateSandbox(active.id, daysAgo(30));

    const agent = await makeAgent({ organizationId: org.id });
    const conversation = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });
    if (!conversation) throw new Error("conversation seed failed");
    const conversationSandbox = await SkillSandboxModel.create({
      ...base,
      conversationId: conversation.id,
    });
    await backdateSandbox(conversationSandbox.id, daysAgo(30));

    const app = await makeApp({ organizationId: org.id });
    const appSandbox = await SkillSandboxModel.findOrCreateAppDefault({
      ...base,
      appId: app.id,
    });
    await backdateSandbox(appSandbox.id, daysAgo(30));

    await handleHeadlessSandboxCleanup();

    for (const kept of [recent, active, conversationSandbox, appSandbox]) {
      expect(await SkillSandboxModel.findById(kept.id)).not.toBeNull();
    }
  });

  test("measures retention in the database clock when its time zone is not UTC", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const base = {
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    };
    await db.execute(sql`SET TIME ZONE 'Etc/GMT+12'`);
    try {
      const fresh = await SkillSandboxModel.create(base);
      const stale = await SkillSandboxModel.create(base);
      await backdateInDatabaseClock(fresh.id, "6 days 18 hours");
      await backdateInDatabaseClock(stale.id, "7 days 6 hours");

      await handleHeadlessSandboxCleanup();

      expect(await SkillSandboxModel.findById(fresh.id)).not.toBeNull();
      expect(await SkillSandboxModel.findById(stale.id)).toBeNull();
    } finally {
      await db.execute(sql`RESET TIME ZONE`);
    }
  });

  test("retention of 0 keeps every sandbox", async ({
    makeOrganization,
    makeUser,
  }) => {
    config.skillsSandbox.headlessRetentionDays = 0;
    const org = await makeOrganization();
    const user = await makeUser();
    const sandbox = await SkillSandboxModel.create({
      organizationId: org.id,
      userId: user.id,
      conversationId: null,
      defaultCwd: "/home/sandbox",
    });
    await backdateSandbox(sandbox.id, daysAgo(365));

    await handleHeadlessSandboxCleanup();

    expect(await SkillSandboxModel.findById(sandbox.id)).not.toBeNull();
  });
});
