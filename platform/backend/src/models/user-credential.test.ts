import { describe, expect } from "vitest";
import { UserCredentialModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { test } from "@/test";

describe("UserCredentialModel", () => {
  test("upsert stores the value in the secrets manager, not the row", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    const credential = await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: user.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "sk-ant-oat-example",
    });

    expect(credential.key).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(JSON.stringify(credential)).not.toContain("sk-ant-oat-example");

    const stored = await secretManager().getSecret(credential.secretId);
    expect(stored?.secret?.value).toBe("sk-ant-oat-example");
  });

  test("upsert rotates in place and discards the superseded secret", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const first = await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: user.id,
      key: "TOKEN",
      value: "old",
    });

    const second = await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: user.id,
      key: "TOKEN",
      value: "new",
    });

    expect(second.id).toBe(first.id);
    expect(second.secretId).not.toBe(first.secretId);
    expect(await secretManager().getSecret(first.secretId)).toBeNull();

    const { values } = await UserCredentialModel.resolveValues({
      organizationId: org.id,
      userId: user.id,
      keys: ["TOKEN"],
    });
    expect(values.TOKEN).toBe("new");
  });

  test("credentials are per user: one user's value is invisible to another", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const owner = await makeUser();
    const other = await makeUser();
    await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: owner.id,
      key: "TOKEN",
      value: "owner-secret",
    });

    const resolved = await UserCredentialModel.resolveValues({
      organizationId: org.id,
      userId: other.id,
      keys: ["TOKEN"],
    });

    expect(resolved.values).toEqual({});
    expect(resolved.missing).toEqual(["TOKEN"]);
  });

  test("resolveValues reports a key whose secret has vanished as missing", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const credential = await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: user.id,
      key: "TOKEN",
      value: "value",
    });

    // Injecting an empty value would fail far from the cause, so a dangling
    // reference has to surface as "missing" instead.
    await secretManager().deleteSecret(credential.secretId);

    const resolved = await UserCredentialModel.resolveValues({
      organizationId: org.id,
      userId: user.id,
      keys: ["TOKEN"],
    });
    expect(resolved.values).toEqual({});
    expect(resolved.missing).toEqual(["TOKEN"]);
  });

  test("listPresentKeys answers only for keys on file", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: user.id,
      key: "PRESENT",
      value: "v",
    });

    const present = await UserCredentialModel.listPresentKeys({
      organizationId: org.id,
      userId: user.id,
      keys: ["PRESENT", "ABSENT"],
    });

    expect([...present]).toEqual(["PRESENT"]);
  });

  test("delete removes the row and its secret", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const credential = await UserCredentialModel.upsert({
      organizationId: org.id,
      userId: user.id,
      key: "TOKEN",
      value: "value",
    });

    expect(
      await UserCredentialModel.delete({
        organizationId: org.id,
        userId: user.id,
        key: "TOKEN",
      }),
    ).toBe(true);
    expect(await secretManager().getSecret(credential.secretId)).toBeNull();
    expect(
      await UserCredentialModel.listForUser({
        organizationId: org.id,
        userId: user.id,
      }),
    ).toEqual([]);
  });
});
