import { ADMIN_ROLE_NAME } from "@archestra/shared";
import config from "@/config";
import { ScheduleTriggerModel } from "@/models";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { findAccessibleScheduleTriggerOrThrow } from "./schedule-trigger-access";

describe("tuner triggers on generic schedule surfaces", () => {
  const enabled = config.tuners.enabled;
  beforeEach(() => {
    config.tuners.enabled = true;
  });
  afterEach(() => {
    config.tuners.enabled = enabled;
  });

  test("are hidden from schedule lists and counts", async ({
    makeOrganization,
    makeUser,
    makeScheduleTrigger,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const plain = await makeScheduleTrigger({
      organizationId: organization.id,
      actorUserId: user.id,
    });
    await makeScheduleTrigger({
      organizationId: organization.id,
      actorUserId: user.id,
      tunerKind: "sre",
    });

    const listed = await ScheduleTriggerModel.listByOrganization({
      organizationId: organization.id,
    });
    const counted = await ScheduleTriggerModel.countByOrganization({
      organizationId: organization.id,
    });

    expect(listed.map((t) => t.id)).toEqual([plain.id]);
    expect(counted).toBe(1);
  });

  test("refuse every generic action, even to the actor", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeScheduleTrigger,
  }) => {
    const organization = await makeOrganization();
    const actor = await makeUser();
    await makeMember(actor.id, organization.id, { role: ADMIN_ROLE_NAME });
    const trigger = await makeScheduleTrigger({
      organizationId: organization.id,
      actorUserId: actor.id,
      tunerKind: "appa",
    });

    for (const access of ["update", "delete", "use"] as const) {
      await expect(
        findAccessibleScheduleTriggerOrThrow({
          id: trigger.id,
          userId: actor.id,
          organizationId: organization.id,
          access,
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  test("can be read only with tuner:read and log:admin", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeCustomRole,
    makeScheduleTrigger,
  }) => {
    const organization = await makeOrganization();
    const actor = await makeUser();
    const trigger = await makeScheduleTrigger({
      organizationId: organization.id,
      actorUserId: actor.id,
      tunerKind: "sre",
    });
    const memberWith = async (permission: Record<string, string[]>) => {
      const role = await makeCustomRole(organization.id, { permission });
      const user = await makeUser();
      await makeMember(user.id, organization.id, { role: role.role });
      return user.id;
    };
    const read = (userId: string) =>
      findAccessibleScheduleTriggerOrThrow({
        id: trigger.id,
        userId,
        organizationId: organization.id,
        access: "read",
      });

    const both = await memberWith({ tuner: ["read"], log: ["read", "admin"] });
    const tunerOnly = await memberWith({ tuner: ["read", "update"] });
    const logAdminOnly = await memberWith({ log: ["read", "admin"] });

    expect((await read(both)).id).toBe(trigger.id);
    await expect(read(tunerOnly)).rejects.toMatchObject({ statusCode: 404 });
    await expect(read(logAdminOnly)).rejects.toMatchObject({
      statusCode: 404,
    });

    config.tuners.enabled = false;
    await expect(read(both)).rejects.toMatchObject({ statusCode: 404 });
  });
});
