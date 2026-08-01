import { ADMIN_ROLE_NAME, MEMBER_ROLE_NAME } from "@archestra/shared";
import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import {
  syncSystemRoleForRoleHolders,
  syncSystemRoleWithOrgPermissions,
} from "./system-role-sync";

async function systemRoleOf(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ role: schema.usersTable.role })
    .from(schema.usersTable)
    .where(eq(schema.usersTable.id, userId));
  return row?.role ?? null;
}

describe("syncSystemRoleWithOrgPermissions", () => {
  test("grants the system role to org admins", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });

    await syncSystemRoleWithOrgPermissions(user.id, org.id);

    expect(await systemRoleOf(user.id)).toBe("admin");
  });

  test("strips the system role when the member is demoted", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ role: "admin" });
    await makeMember(user.id, org.id, { role: MEMBER_ROLE_NAME });

    await syncSystemRoleWithOrgPermissions(user.id, org.id);

    expect(await systemRoleOf(user.id)).toBeNull();
  });

  test("follows a custom role's member:impersonate grant", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const granted = await makeUser();
    const denied = await makeUser();
    const impersonatingRole = await makeCustomRole(org.id, {
      permission: { member: ["read", "impersonate"] },
    });
    const plainRole = await makeCustomRole(org.id, {
      permission: { member: ["read", "create", "update", "delete"] },
    });
    await makeMember(granted.id, org.id, { role: impersonatingRole.role });
    await makeMember(denied.id, org.id, { role: plainRole.role });

    await syncSystemRoleWithOrgPermissions(granted.id, org.id);
    await syncSystemRoleWithOrgPermissions(denied.id, org.id);

    expect(await systemRoleOf(granted.id)).toBe("admin");
    expect(await systemRoleOf(denied.id)).toBeNull();
  });

  test("strips the system role when the membership is gone", async ({
    makeUser,
    makeOrganization,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ role: "admin" });

    await syncSystemRoleWithOrgPermissions(user.id, org.id);

    expect(await systemRoleOf(user.id)).toBeNull();
  });

  test("is a no-op when already in sync", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser({ role: "admin" });
    await makeMember(user.id, org.id, { role: ADMIN_ROLE_NAME });

    await syncSystemRoleWithOrgPermissions(user.id, org.id);

    expect(await systemRoleOf(user.id)).toBe("admin");
  });
});

describe("syncSystemRoleForRoleHolders", () => {
  test("resyncs every member holding the role", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
  }) => {
    const org = await makeOrganization();
    const role = await makeCustomRole(org.id, {
      permission: { member: ["read", "impersonate"] },
    });
    const holderA = await makeUser();
    const holderB = await makeUser();
    const bystander = await makeUser();
    await makeMember(holderA.id, org.id, { role: role.role });
    await makeMember(holderB.id, org.id, { role: role.role });
    await makeMember(bystander.id, org.id, { role: MEMBER_ROLE_NAME });

    await syncSystemRoleForRoleHolders(role.role, org.id);

    expect(await systemRoleOf(holderA.id)).toBe("admin");
    expect(await systemRoleOf(holderB.id)).toBe("admin");
    expect(await systemRoleOf(bystander.id)).toBeNull();
  });
});
