// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import { expect, test } from "@/test";

const migration = fs.readFileSync(
  path.join(__dirname, "0509_fold-rbac-settings-resources.sql"),
  "utf8",
);

async function permissions(id: string) {
  const [role] = await db
    .select()
    .from(schema.organizationRolesTable)
    .where(eq(schema.organizationRolesTable.id, id));
  return JSON.parse(role.permission);
}

test("drops retired resources without widening organization settings", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const settingsEditor = await makeCustomRole(org.id, {
    permission: {
      agent: ["read", "update"],
      llmSettings: ["read", "update"],
      knowledgeSettings: ["read"],
      agentTrigger: ["read", "create"],
      siteNotification: ["read", "create"],
      sandbox: ["execute"],
      secret: ["read", "update"],
      file: ["manage"],
    },
  });

  await db.execute(sql.raw(migration));

  expect(await permissions(settingsEditor.id)).toEqual({
    agent: ["read", "update"],
  });
});

test("invitations follow member:create and repeated runs change nothing", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const recruiter = await makeCustomRole(org.id, {
    permission: { member: ["read", "create"] },
  });
  const inviteOnly = await makeCustomRole(org.id, {
    permission: { member: ["read"], invitation: ["create", "cancel"] },
  });
  const settingsAdmin = await makeCustomRole(org.id, {
    permission: { organizationSettings: ["read", "update"] },
  });

  await db.execute(sql.raw(migration));
  const first = await permissions(recruiter.id);
  await db.execute(sql.raw(migration));

  expect(await permissions(recruiter.id)).toEqual(first);
  expect(first).toEqual({
    member: ["read", "create"],
    invitation: ["create", "cancel"],
  });
  expect(await permissions(inviteOnly.id)).toEqual({ member: ["read"] });
  expect(await permissions(settingsAdmin.id)).toEqual({
    organizationSettings: ["read", "update"],
  });
});

test("the three chat view toggles become chat:full-view, granted when any was held", async ({
  makeOrganization,
  makeCustomRole,
}) => {
  const org = await makeOrganization();
  const pickerOnly = await makeCustomRole(org.id, {
    permission: { chat: ["read"], chatAgentPicker: ["enable"] },
  });
  const allThree = await makeCustomRole(org.id, {
    permission: {
      chatAgentPicker: ["enable"],
      chatProviderSettings: ["enable"],
      chatExpandToolCalls: ["enable"],
    },
  });
  const simpleChat = await makeCustomRole(org.id, {
    permission: { chat: ["read"], chatProviderSettings: [] },
  });

  await db.execute(sql.raw(migration));
  await db.execute(sql.raw(migration));

  expect(await permissions(pickerOnly.id)).toEqual({
    chat: ["read", "full-view"],
  });
  expect(await permissions(allThree.id)).toEqual({ chat: ["full-view"] });
  expect(await permissions(simpleChat.id)).toEqual({ chat: ["read"] });
});
