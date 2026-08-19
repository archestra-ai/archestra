import { MEMBER_ROLE_NAME } from "@archestra/shared";
import { RoleResourceAccessModel } from "@/models";
import { describe, expect, test } from "@/test";

describe("RoleResourceAccessModel", () => {
  test("a role with nothing stored is unrestricted", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();

    expect(
      await RoleResourceAccessModel.getForRole({
        organizationId: organization.id,
        role: MEMBER_ROLE_NAME,
      }),
    ).toEqual({
      modelProviders: null,
      knowledgeConnectors: null,
      messagingChannels: null,
      connectClients: null,
    });
  });

  test("stores an empty list as a real 'nothing allowed'", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();

    await RoleResourceAccessModel.upsert({
      organizationId: organization.id,
      role: MEMBER_ROLE_NAME,
      access: { messagingChannels: [] },
    });

    const stored = await RoleResourceAccessModel.getForRole({
      organizationId: organization.id,
      role: MEMBER_ROLE_NAME,
    });
    expect(stored.messagingChannels).toEqual([]);
    // Kinds the caller did not send stay unrestricted.
    expect(stored.modelProviders).toBeNull();
  });

  test("an omitted kind keeps its stored list, an explicit null clears it", async ({
    makeOrganization,
  }) => {
    const organization = await makeOrganization();
    const role = MEMBER_ROLE_NAME;

    await RoleResourceAccessModel.upsert({
      organizationId: organization.id,
      role,
      access: { modelProviders: ["openai"], messagingChannels: ["slack"] },
    });
    await RoleResourceAccessModel.upsert({
      organizationId: organization.id,
      role,
      access: { messagingChannels: null },
    });

    expect(
      await RoleResourceAccessModel.getForRole({
        organizationId: organization.id,
        role,
      }),
    ).toMatchObject({
      modelProviders: ["openai"],
      messagingChannels: null,
    });
  });

  test("keeps organizations apart", async ({ makeOrganization }) => {
    const [restricted, other] = [
      await makeOrganization(),
      await makeOrganization(),
    ];

    await RoleResourceAccessModel.upsert({
      organizationId: restricted.id,
      role: MEMBER_ROLE_NAME,
      access: { modelProviders: ["openai"] },
    });

    expect(
      (
        await RoleResourceAccessModel.getForRole({
          organizationId: other.id,
          role: MEMBER_ROLE_NAME,
        })
      ).modelProviders,
    ).toBeNull();
  });

  describe("getOrganizationUnion", () => {
    test("is unrestricted while any role still has no list", async ({
      makeOrganization,
    }) => {
      const organization = await makeOrganization();

      await RoleResourceAccessModel.upsert({
        organizationId: organization.id,
        role: MEMBER_ROLE_NAME,
        access: { messagingChannels: ["slack"] },
      });

      // admin/editor/platform_admin are still unrestricted, so the channel
      // stays reachable by somebody and the bots keep listening.
      expect(
        (await RoleResourceAccessModel.getOrganizationUnion(organization.id))
          .messagingChannels,
      ).toBeNull();
    });

    test("merges the lists once every role carries one", async ({
      makeOrganization,
      restrictRoleResourceAccess,
    }) => {
      const organization = await makeOrganization();

      await restrictRoleResourceAccess(organization.id, {
        messagingChannels: ["slack"],
      });
      await RoleResourceAccessModel.upsert({
        organizationId: organization.id,
        role: MEMBER_ROLE_NAME,
        access: { messagingChannels: ["telegram"] },
      });

      const union = await RoleResourceAccessModel.getOrganizationUnion(
        organization.id,
      );
      expect(union.messagingChannels?.slice().sort()).toEqual([
        "slack",
        "telegram",
      ]);
    });

    test("counts a custom role that has no list as unrestricted", async ({
      makeOrganization,
      makeCustomRole,
      restrictRoleResourceAccess,
    }) => {
      const organization = await makeOrganization();
      await restrictRoleResourceAccess(organization.id, {
        messagingChannels: [],
      });
      await makeCustomRole(organization.id);

      expect(
        (await RoleResourceAccessModel.getOrganizationUnion(organization.id))
          .messagingChannels,
      ).toBeNull();
    });
  });
});
