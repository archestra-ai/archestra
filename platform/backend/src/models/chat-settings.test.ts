import { describe, expect, test } from "@/test";
import ChatSettingsModel from "./chat-settings";

describe("ChatSettingsModel", () => {
  test("can create chat settings", async ({ makeOrganization }) => {
    const org = await makeOrganization();

    const settings = await ChatSettingsModel.create({
      organizationId: org.id,
    });

    expect(settings).toBeDefined();
    expect(settings.id).toBeDefined();
    expect(settings.organizationId).toBe(org.id);
    expect(settings.createdAt).toBeDefined();
    expect(settings.updatedAt).toBeDefined();
    expect(settings.anthropicApiKeySecretId).toBeNull();
  });

  test("can find chat settings by organization id", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const created = await ChatSettingsModel.create({
      organizationId: org.id,
    });

    const found = await ChatSettingsModel.findByOrganizationId(org.id);

    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.organizationId).toBe(org.id);
    expect(found?.anthropicApiKeySecretId).toBeNull();
  });

  test("returns null when chat settings not found", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const found = await ChatSettingsModel.findByOrganizationId(org.id);

    expect(found).toBeNull();
  });

  test("getOrCreate returns existing settings when they exist", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // Create settings first
    const created = await ChatSettingsModel.create({
      organizationId: org.id,
    });

    // getOrCreate should return the existing settings
    const settings = await ChatSettingsModel.getOrCreate(org.id);

    expect(settings).toBeDefined();
    expect(settings.id).toBe(created.id);
    expect(settings.organizationId).toBe(org.id);
  });

  test("getOrCreate creates new settings when they don't exist", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // No existing settings
    const existing = await ChatSettingsModel.findByOrganizationId(org.id);
    expect(existing).toBeNull();

    // getOrCreate should create new settings
    const settings = await ChatSettingsModel.getOrCreate(org.id);

    expect(settings).toBeDefined();
    expect(settings.id).toBeDefined();
    expect(settings.organizationId).toBe(org.id);
    expect(settings.anthropicApiKeySecretId).toBeNull();
  });

  test("can update chat settings", async ({ makeOrganization, makeSecret }) => {
    const org = await makeOrganization();
    const secret = await makeSecret();

    const created = await ChatSettingsModel.create({
      organizationId: org.id,
    });

    // Update with a real secret ID
    const updated = await ChatSettingsModel.update(org.id, {
      anthropicApiKeySecretId: secret.id,
    });

    expect(updated).toBeDefined();
    expect(updated?.id).toBe(created.id);
    expect(updated?.organizationId).toBe(org.id);
    expect(updated?.anthropicApiKeySecretId).toBe(secret.id);
  });

  test("returns null when updating non-existent chat settings", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    const result = await ChatSettingsModel.update(org.id, {
      anthropicApiKeySecretId: null,
    });

    expect(result).toBeNull();
  });

  test("isolates settings by organization", async ({ makeOrganization }) => {
    const org1 = await makeOrganization();
    const org2 = await makeOrganization();

    // Create settings for org1
    await ChatSettingsModel.create({
      organizationId: org1.id,
    });

    // Create settings for org2
    await ChatSettingsModel.create({
      organizationId: org2.id,
    });

    // Each org should only see their own settings
    const org1Settings = await ChatSettingsModel.findByOrganizationId(org1.id);
    const org2Settings = await ChatSettingsModel.findByOrganizationId(org2.id);

    expect(org1Settings).toBeDefined();
    expect(org2Settings).toBeDefined();
    expect(org1Settings?.organizationId).toBe(org1.id);
    expect(org2Settings?.organizationId).toBe(org2.id);
    expect(org1Settings?.id).not.toBe(org2Settings?.id);
  });

  test("can create settings with anthropic api key secret id", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret();

    const settings = await ChatSettingsModel.create({
      organizationId: org.id,
      anthropicApiKeySecretId: secret.id,
    });

    expect(settings).toBeDefined();
    expect(settings.organizationId).toBe(org.id);
    expect(settings.anthropicApiKeySecretId).toBe(secret.id);
  });

  test("update preserves existing data when partial update", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret1 = await makeSecret();
    const secret2 = await makeSecret();

    const created = await ChatSettingsModel.create({
      organizationId: org.id,
      anthropicApiKeySecretId: secret1.id,
    });

    // Update only changes the specific field, preserves others
    const updated = await ChatSettingsModel.update(org.id, {
      anthropicApiKeySecretId: secret2.id,
    });

    expect(updated).toBeDefined();
    expect(updated?.id).toBe(created.id);
    expect(updated?.organizationId).toBe(org.id);
    expect(updated?.anthropicApiKeySecretId).toBe(secret2.id);
  });

  test("update can set anthropicApiKeySecretId to null", async ({
    makeOrganization,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const secret = await makeSecret();

    const created = await ChatSettingsModel.create({
      organizationId: org.id,
      anthropicApiKeySecretId: secret.id,
    });

    const updated = await ChatSettingsModel.update(org.id, {
      anthropicApiKeySecretId: null,
    });

    expect(updated).toBeDefined();
    expect(updated?.id).toBe(created.id);
    expect(updated?.organizationId).toBe(org.id);
    expect(updated?.anthropicApiKeySecretId).toBeNull();
  });

  test("handles multiple getOrCreate calls for same organization safely", async ({
    makeOrganization,
  }) => {
    const org = await makeOrganization();

    // First call creates settings
    const settings1 = await ChatSettingsModel.getOrCreate(org.id);

    // Second call returns existing settings
    const settings2 = await ChatSettingsModel.getOrCreate(org.id);

    expect(settings1.id).toBe(settings2.id);
    expect(settings1.organizationId).toBe(org.id);
    expect(settings2.organizationId).toBe(org.id);
  });
});
