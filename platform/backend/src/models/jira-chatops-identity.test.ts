import { randomUUID } from "node:crypto";
import UserModel from "@/models/user";
import { describe, expect, test } from "@/test";
import JiraChatOpsIdentityModel from "./jira-chatops-identity";

describe("persisted Jira human identities", () => {
  test("pins one user to a canonical colon-bearing account and fences reads by integration and organization", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const user = await makeUser();
    const identity = {
      integrationId: randomUUID(),
      organizationId: organization.id,
      accountId: "712020:canonical-human-account",
      userId: user.id,
    };
    const first = await JiraChatOpsIdentityModel.remember(identity);
    const second = await JiraChatOpsIdentityModel.remember(identity);
    expect(second.id).toBe(first.id);
    expect(await JiraChatOpsIdentityModel.find(identity)).toMatchObject({
      id: first.id,
      userId: user.id,
    });
    expect(
      await JiraChatOpsIdentityModel.find({
        ...identity,
        integrationId: randomUUID(),
      }),
    ).toBeNull();
    expect(
      await JiraChatOpsIdentityModel.find({
        ...identity,
        organizationId: otherOrganization.id,
      }),
    ).toBeNull();
    expect(
      await JiraChatOpsIdentityModel.find({
        ...identity,
        accountId: "712020:another-human",
      }),
    ).toBeNull();
  });

  test("compare-and-set refuses a different human or organization without replacing the first observation", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const otherOrganization = await makeOrganization();
    const firstUser = await makeUser();
    const secondUser = await makeUser();
    const identity = {
      integrationId: randomUUID(),
      organizationId: organization.id,
      accountId: "canonical-account",
      userId: firstUser.id,
    };
    await JiraChatOpsIdentityModel.remember(identity);
    await expect(
      JiraChatOpsIdentityModel.remember({ ...identity, userId: secondUser.id }),
    ).rejects.toThrow("association conflict");
    await expect(
      JiraChatOpsIdentityModel.remember({
        ...identity,
        organizationId: otherOrganization.id,
      }),
    ).rejects.toThrow("association conflict");
    expect((await JiraChatOpsIdentityModel.find(identity))?.userId).toBe(
      firstUser.id,
    );
  });

  test("human deletion retains an unclaimable tombstone rather than enabling service fallback", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const otherUser = await makeUser();
    const identity = {
      integrationId: randomUUID(),
      organizationId: organization.id,
      accountId: "canonical-account",
      userId: user.id,
    };
    const remembered = await JiraChatOpsIdentityModel.remember(identity);
    await UserModel.delete(user.id);
    expect(await JiraChatOpsIdentityModel.find(identity)).toMatchObject({
      id: remembered.id,
      userId: null,
    });
    await expect(
      JiraChatOpsIdentityModel.remember({ ...identity, userId: otherUser.id }),
    ).rejects.toThrow("association conflict");
  });

  test("rejects empty or oversized canonical accounts", async ({
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const user = await makeUser();
    const identity = {
      integrationId: randomUUID(),
      organizationId: organization.id,
      accountId: "",
      userId: user.id,
    };
    await expect(JiraChatOpsIdentityModel.remember(identity)).rejects.toThrow(
      "Invalid Jira account",
    );
    await expect(
      JiraChatOpsIdentityModel.remember({
        ...identity,
        accountId: "a".repeat(257),
      }),
    ).rejects.toThrow("Invalid Jira account");
  });
});
